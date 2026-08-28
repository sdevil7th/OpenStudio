#include "MainComponent.h"
#include "ApplicationLaunchState.h"
#include <array>
#include <atomic>
#include <set>
#include <thread>
#include <algorithm>
#include <cmath>
#include <limits>
#include <optional>
#include <regex>
#include <vector>

#if ! JUCE_WINDOWS
#include <sys/stat.h>
#endif

#if JUCE_WINDOWS
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
#include <windows.h>
#include <wincrypt.h>
#include <oleidl.h>
#include <shellapi.h>
#endif

#ifndef OPENSTUDIO_TONE3000_CLIENT_ID
 #define OPENSTUDIO_TONE3000_CLIENT_ID ""
#endif

#if JUCE_WINDOWS
class MainComponent::ExternalMediaDropTarget final : public IDropTarget
{
public:
    explicit ExternalMediaDropTarget(MainComponent& ownerIn)
        : owner(ownerIn)
    {
    }

    ~ExternalMediaDropTarget()
    {
        for (auto hwnd : registeredWindows)
            if (hwnd != nullptr && ::IsWindow(hwnd))
                ::RevokeDragDrop(hwnd);

        if (calledOleInitialize)
            ::OleUninitialize();
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override
    {
        if (object == nullptr)
            return E_POINTER;

        if (iid == IID_IUnknown || iid == IID_IDropTarget)
        {
            *object = static_cast<IDropTarget*>(this);
            AddRef();
            return S_OK;
        }

        *object = nullptr;
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override
    {
        return static_cast<ULONG>(refCount.fetch_add(1, std::memory_order_relaxed) + 1);
    }

    ULONG STDMETHODCALLTYPE Release() override
    {
        const auto next = refCount.fetch_sub(1, std::memory_order_relaxed) - 1;
        return static_cast<ULONG>(next);
    }

    HRESULT STDMETHODCALLTYPE DragEnter(IDataObject* dataObject, DWORD, POINTL point, DWORD* effect) override
    {
        lastFiles = extractFiles(dataObject);
        if (lastFiles.isEmpty())
        {
            activeDragId.clear();
            setEffect(effect, DROPEFFECT_NONE);
            return S_OK;
        }

        activeDragId = "native-drop-" + juce::String(++dragCounter);
        foregroundRequestedThisDrag = false;
        requestForegroundOnce();
        owner.emitExternalMediaDropTargetEvent("externalMediaDragEnter", buildPayload(activeDragId, lastFiles, point));
        setEffect(effect, DROPEFFECT_COPY);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE DragOver(DWORD, POINTL point, DWORD* effect) override
    {
        if (activeDragId.isNotEmpty())
        {
            owner.emitExternalMediaDropTargetEvent("externalMediaDragMove", buildPayload(activeDragId, lastFiles, point));
            setEffect(effect, DROPEFFECT_COPY);
        }
        else
        {
            setEffect(effect, DROPEFFECT_NONE);
        }

        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE DragLeave() override
    {
        if (activeDragId.isNotEmpty())
            owner.emitExternalMediaDropTargetEvent("externalMediaDragLeave", buildPayload(activeDragId, juce::StringArray(), POINTL{}));

        activeDragId.clear();
        lastFiles.clear();
        foregroundRequestedThisDrag = false;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE Drop(IDataObject* dataObject, DWORD, POINTL point, DWORD* effect) override
    {
        auto files = extractFiles(dataObject);
        if (files.isEmpty())
            files = lastFiles;

        if (activeDragId.isNotEmpty() && ! files.isEmpty())
        {
            owner.emitExternalMediaDropTargetEvent("externalMediaDrop", buildPayload(activeDragId, files, point));
            setEffect(effect, DROPEFFECT_COPY);
        }
        else
        {
            setEffect(effect, DROPEFFECT_NONE);
        }

        activeDragId.clear();
        lastFiles.clear();
        foregroundRequestedThisDrag = false;
        return S_OK;
    }

    void registerWindow(HWND hwnd)
    {
        if (hwnd == nullptr || registeredWindows.count(hwnd) != 0)
            return;

        auto result = ::RegisterDragDrop(hwnd, this);
        if (result == CO_E_NOTINITIALIZED && ! calledOleInitialize)
        {
            if (SUCCEEDED(::OleInitialize(nullptr)))
            {
                calledOleInitialize = true;
                result = ::RegisterDragDrop(hwnd, this);
            }
        }

        if (result == DRAGDROP_E_ALREADYREGISTERED)
        {
            ::RevokeDragDrop(hwnd);
            result = ::RegisterDragDrop(hwnd, this);
        }

        if (SUCCEEDED(result))
        {
            registeredWindows.insert(hwnd);
            juce::Logger::writeToLog("External media drop target registered");
        }
    }

private:
    static void setEffect(DWORD* effect, DWORD value)
    {
        if (effect != nullptr)
            *effect = value;
    }

    static juce::StringArray extractFiles(IDataObject* dataObject)
    {
        juce::StringArray files;
        if (dataObject == nullptr)
            return files;

        FORMATETC format {};
        format.cfFormat = CF_HDROP;
        format.dwAspect = DVASPECT_CONTENT;
        format.lindex = -1;
        format.tymed = TYMED_HGLOBAL;

        STGMEDIUM medium {};
        if (FAILED(dataObject->GetData(&format, &medium)))
            return files;

        auto dropHandle = reinterpret_cast<HDROP>(medium.hGlobal);
        const auto count = ::DragQueryFileW(dropHandle, 0xFFFFFFFF, nullptr, 0);
        for (UINT i = 0; i < count; ++i)
        {
            const auto length = ::DragQueryFileW(dropHandle, i, nullptr, 0);
            if (length == 0)
                continue;

            std::wstring path;
            path.resize(static_cast<size_t>(length) + 1);
            if (::DragQueryFileW(dropHandle, i, path.data(), length + 1) > 0)
            {
                const juce::String filePath(path.c_str());
                if (! files.contains(filePath, true))
                    files.add(filePath);
            }
        }

        ::ReleaseStgMedium(&medium);
        return files;
    }

    juce::Point<int> toClientPoint(POINTL point) const
    {
        if (auto* peer = owner.getPeer())
        {
            auto hwnd = static_cast<HWND>(peer->getNativeHandle());
            POINT nativePoint { static_cast<LONG>(point.x), static_cast<LONG>(point.y) };
            if (hwnd != nullptr && ::ScreenToClient(hwnd, &nativePoint) != 0)
                return { static_cast<int>(nativePoint.x), static_cast<int>(nativePoint.y) };
        }

        return { static_cast<int>(point.x), static_cast<int>(point.y) };
    }

    void requestForegroundOnce()
    {
        if (foregroundRequestedThisDrag)
            return;

        foregroundRequestedThisDrag = true;
        owner.bringMainWindowToFrontForExternalMediaDrag();
    }

    juce::var buildPayload(const juce::String& dragId, const juce::StringArray& files, POINTL point) const
    {
        auto* payload = new juce::DynamicObject();
        const auto clientPoint = toClientPoint(point);
        payload->setProperty("dragId", dragId);
        payload->setProperty("clientX", clientPoint.x);
        payload->setProperty("clientY", clientPoint.y);
        payload->setProperty("nativeClientX", clientPoint.x);
        payload->setProperty("nativeClientY", clientPoint.y);
        payload->setProperty("screenX", static_cast<int>(point.x));
        payload->setProperty("screenY", static_cast<int>(point.y));
        payload->setProperty("deviceScaleFactor", owner.getDesktopScaleFactor());

        juce::Array<juce::var> fileArray;
        for (const auto& path : files)
        {
            juce::File file(path);
            auto* item = new juce::DynamicObject();
            item->setProperty("path", file.getFullPathName());
            item->setProperty("name", file.getFileName());
            item->setProperty("extension", file.getFileExtension().toLowerCase());
            item->setProperty("size", static_cast<double>(file.getSize()));
            fileArray.add(juce::var(item));
        }
        payload->setProperty("files", fileArray);
        return juce::var(payload);
    }

    MainComponent& owner;
    std::atomic<uint32_t> refCount { 1 };
    std::set<HWND> registeredWindows;
    juce::String activeDragId;
    juce::StringArray lastFiles;
    uint64_t dragCounter = 0;
    bool calledOleInitialize = false;
    bool foregroundRequestedThisDrag = false;
};
#endif

namespace
{
constexpr int kFrontendStartupTimeoutMs = 8000;

static bool shouldEnablePitchEditorFormantDebugLogs()
{
#if JUCE_DEBUG
    return true;
#else
    return juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_PITCH_DEBUG", {}).trim() == "1";
#endif
}
static void logPitchEditorFormant(const juce::String& message)
{
    if (shouldEnablePitchEditorFormantDebugLogs())
        juce::Logger::writeToLog ("[pitchEditor.formant] " + message);
}

#ifndef OPENSTUDIO_AUDIO_BRIDGE_DEBUG
 #define OPENSTUDIO_AUDIO_BRIDGE_DEBUG 0
#endif

#if OPENSTUDIO_AUDIO_BRIDGE_DEBUG
static void logAudioBridge(const juce::String& message)
{
    juce::Logger::writeToLog("[audio.bridge] " + message);
}
 #define OPENSTUDIO_LOG_AUDIO_BRIDGE(message) logAudioBridge(message)
#else
 #define OPENSTUDIO_LOG_AUDIO_BRIDGE(message) do { } while (false)
#endif

static juce::var buildMediaInfoResult(const juce::File& mediaFile,
                                      const juce::File& resultFile,
                                      juce::AudioFormatReader& reader)
{
    auto* result = new juce::DynamicObject();
    const auto duration = reader.sampleRate > 0.0 ? reader.lengthInSamples / reader.sampleRate : 0.0;
    result->setProperty("filePath", resultFile.getFullPathName());
    result->setProperty("duration", duration);
    result->setProperty("sampleRate", static_cast<int>(reader.sampleRate));
    result->setProperty("numChannels", static_cast<int>(reader.numChannels));
    result->setProperty("format", mediaFile.getFileExtension().toUpperCase().trimCharactersAtStart("."));
    return juce::var(result);
}

static juce::var probeReadableMediaFile(const juce::String& filePath)
{
    juce::File mediaFile(filePath);
    if (! mediaFile.existsAsFile())
        return juce::var();

    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(mediaFile));
    if (reader == nullptr)
        return juce::var();

    return buildMediaInfoResult(mediaFile, mediaFile, *reader);
}

static juce::var buildWaveformPreviewPayload(const juce::String& requestId,
                                             const juce::String& filePath,
                                             int maxPoints)
{
    juce::File audioFile(filePath);
    if (! audioFile.existsAsFile())
        return juce::var();

    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(audioFile));
    if (reader == nullptr || reader->lengthInSamples <= 0 || reader->numChannels <= 0)
        return juce::var();

    const int channels = juce::jlimit(1, 8, static_cast<int>(reader->numChannels));
    const int pointCount = juce::jlimit(64, 4096, juce::jmin(maxPoints, static_cast<int>(reader->lengthInSamples)));
    const auto samplesPerPoint = std::max<juce::int64>(
        1, (reader->lengthInSamples + pointCount - 1) / pointCount);
    juce::Array<juce::var> peaks;
    peaks.ensureStorageAllocated(1 + pointCount * channels * 2);
    peaks.add(channels);

    std::vector<float> mins(static_cast<size_t>(pointCount * channels), 0.0f);
    std::vector<float> maxs(static_cast<size_t>(pointCount * channels), 0.0f);
    std::vector<uint8_t> touched(static_cast<size_t>(pointCount * channels), 0);

    constexpr int chunkSize = 65536;
    juce::AudioBuffer<float> buffer(channels, chunkSize);
    juce::int64 samplePos = 0;
    while (samplePos < reader->lengthInSamples)
    {
        const int samplesToRead = static_cast<int>(
            std::min<juce::int64>(chunkSize, reader->lengthInSamples - samplePos));
        buffer.clear();
        if (! reader->read(&buffer, 0, samplesToRead, samplePos, true, true))
            break;

        for (int s = 0; s < samplesToRead; ++s)
        {
            const auto absoluteSample = samplePos + s;
            const int pointIndex = juce::jlimit(0, pointCount - 1, static_cast<int>(absoluteSample / samplesPerPoint));
            for (int ch = 0; ch < channels; ++ch)
            {
                const auto index = static_cast<size_t>(pointIndex * channels + ch);
                const auto value = buffer.getSample(ch, s);
                if (touched[index] == 0)
                {
                    mins[index] = value;
                    maxs[index] = value;
                    touched[index] = 1;
                }
                else
                {
                    mins[index] = juce::jmin(mins[index], value);
                    maxs[index] = juce::jmax(maxs[index], value);
                }
            }
        }

        samplePos += samplesToRead;
    }

    for (int point = 0; point < pointCount; ++point)
    {
        for (int ch = 0; ch < channels; ++ch)
        {
            const auto index = static_cast<size_t>(point * channels + ch);
            peaks.add(juce::var(touched[index] != 0 ? mins[index] : 0.0f));
            peaks.add(juce::var(touched[index] != 0 ? maxs[index] : 0.0f));
        }
    }

    auto* payload = new juce::DynamicObject();
    payload->setProperty("requestId", requestId);
    payload->setProperty("filePath", audioFile.getFullPathName());
    payload->setProperty("duration", reader->sampleRate > 0.0 ? reader->lengthInSamples / reader->sampleRate : 0.0);
    payload->setProperty("sampleRate", static_cast<int>(reader->sampleRate));
    payload->setProperty("numChannels", channels);
    payload->setProperty("complete", true);
    payload->setProperty("peaks", peaks);
    return juce::var(payload);
}

juce::WebBrowserComponent::Options::Backend getPreferredBrowserBackend()
{
   #if JUCE_WINDOWS
    return juce::WebBrowserComponent::Options::Backend::webview2;
   #else
    return juce::WebBrowserComponent::Options::Backend::defaultBackend;
   #endif
}

juce::File getExecutableDirectory()
{
    return juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
}

juce::File getRuntimeAssetRoot()
{
#if JUCE_MAC
    const auto resourcesDir = getExecutableDirectory().getParentDirectory().getChildFile("Resources");
    if (resourcesDir.isDirectory())
        return resourcesDir;
#endif

    return getExecutableDirectory();
}

juce::Array<juce::File> getPackagedFrontendCandidates()
{
    const auto exeDir = getExecutableDirectory();
    return {
        exeDir.getChildFile("webui").getChildFile("index.html"),
        exeDir.getParentDirectory().getChildFile("Resources").getChildFile("webui").getChildFile("index.html"),
        exeDir.getChildFile("../../../frontend/dist/index.html")
    };
}

juce::File getPackagedFrontendEntryPoint()
{
    const auto candidates = getPackagedFrontendCandidates();

    for (const auto& candidate : candidates)
        if (candidate.existsAsFile())
            return candidate;

    return {};
}

juce::File getWebView2UserDataFolder()
{
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("OpenStudio")
        .getChildFile("WebView2UserData");
}

juce::WebBrowserComponent::Options getEmbeddedBrowserBaseOptions()
{
    auto options = juce::WebBrowserComponent::Options()
                       .withBackend(getPreferredBrowserBackend())
                       .withKeepPageLoadedWhenBrowserIsHidden();

#if JUCE_WINDOWS
    // This writable per-user location is part of the browser availability
    // contract, not just a runtime preference.  A Win32 WebView2 without an
    // explicit UDF tries to create one beside the executable, which fails for
    // normal users when OpenStudio is installed under Program Files.
    options = options.withWinWebView2Options(
        juce::WebBrowserComponent::Options::WinWebView2()
            .withUserDataFolder(getWebView2UserDataFolder())
            .withStatusBarDisabled());
#endif

    return options;
}

juce::File getStartupLogFile()
{
    auto logDir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                    .getChildFile("OpenStudio")
                    .getChildFile("logs");

    if (logDir.createDirectory())
        return logDir.getChildFile("OpenStudio_Startup.log");

    return getExecutableDirectory().getChildFile("OpenStudio_Debug.log");
}

juce::File getRecentProjectsFile()
{
    auto appDataDir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                        .getChildFile("OpenStudio");
    appDataDir.createDirectory();
    return appDataDir.getChildFile("recent_projects.json");
}

juce::var readRecentProjectsFile()
{
    juce::Array<juce::var> empty;
    const auto file = getRecentProjectsFile();
    if (! file.existsAsFile())
        return juce::var(empty);

    const auto parsed = juce::JSON::parse(file.loadFileAsString());
    if (parsed.isArray())
        return parsed;

    return juce::var(empty);
}

bool writeRecentProjectsFile(const juce::var& rawProjects)
{
    auto* projects = rawProjects.getArray();
    if (projects == nullptr)
        return false;

    juce::StringArray seen;
    juce::Array<juce::var> sanitized;
    for (const auto& item : *projects)
    {
        const auto path = item.toString().trim();
        if (path.isEmpty() || seen.contains(path))
            continue;

        seen.add(path);
        sanitized.add(path);
        if (sanitized.size() >= 10)
            break;
    }

    return getRecentProjectsFile().replaceWithText(juce::JSON::toString(juce::var(sanitized), false));
}

juce::String describeBrowserBackend(juce::WebBrowserComponent::Options::Backend backend)
{
    switch (backend)
    {
        case juce::WebBrowserComponent::Options::Backend::defaultBackend: return "defaultBackend";
        case juce::WebBrowserComponent::Options::Backend::ie: return "ie";
        case juce::WebBrowserComponent::Options::Backend::webview2: return "webview2";
    }

    return "unknown";
}

juce::String describeCandidatePaths()
{
    juce::StringArray lines;
    for (const auto& candidate : getPackagedFrontendCandidates())
        lines.add(" - " + candidate.getFullPathName());
    return lines.joinIntoString("\n");
}

struct RuntimeAssetCheck
{
    juce::String description;
    juce::File path;
};

juce::File getPackagedFrontendRoot()
{
    const auto entryPoint = getPackagedFrontendEntryPoint();
    return entryPoint.existsAsFile() ? entryPoint.getParentDirectory() : juce::File();
}

juce::Array<RuntimeAssetCheck> getShellCriticalRuntimeAssetChecks()
{
    const auto runtimeRoot = getRuntimeAssetRoot();
    juce::Array<RuntimeAssetCheck> checks;

    checks.add({ "packaged frontend entry point", runtimeRoot.getChildFile("webui").getChildFile("index.html") });
    return checks;
}

juce::Array<RuntimeAssetCheck> getBundledFeatureAssetChecks()
{
    const auto runtimeRoot = getRuntimeAssetRoot();
    juce::Array<RuntimeAssetCheck> checks;

   #if JUCE_WINDOWS
    const auto ffmpegName = "ffmpeg.exe";
   #else
    const auto ffmpegName = "ffmpeg";
   #endif

    checks.add({ "bundled effects directory", runtimeRoot.getChildFile("effects") });
    checks.add({ "bundled scripts directory", runtimeRoot.getChildFile("scripts") });
    checks.add({ "core pitch model", runtimeRoot.getChildFile("models").getChildFile("basic_pitch_nmp.onnx") });
    checks.add({ "bundled ffmpeg binary", runtimeRoot.getChildFile(ffmpegName) });

    return checks;
}

juce::StringArray getMissingRuntimeAssets(const juce::Array<RuntimeAssetCheck>& checks)
{
    juce::StringArray missingAssets;

    for (const auto& check : checks)
    {
        const bool exists = check.path.isDirectory() || check.path.existsAsFile();
        if (! exists)
            missingAssets.add(check.description + " -> " + check.path.getFullPathName());
    }

    return missingAssets;
}

juce::String normaliseFrontendAssetPath(const juce::String& assetPath)
{
    auto path = assetPath.upToFirstOccurrenceOf("?", false, false)
                         .upToFirstOccurrenceOf("#", false, false)
                         .trim();

    if (path.startsWithIgnoreCase("http://")
        || path.startsWithIgnoreCase("https://")
        || path.startsWithIgnoreCase("data:")
        || path.startsWithIgnoreCase("javascript:")
        || path.startsWithIgnoreCase("mailto:")
        || path.startsWithChar('#'))
    {
        return {};
    }

    while (path.startsWithChar('/'))
        path = path.substring(1);

    if (path.startsWithIgnoreCase("./"))
        path = path.substring(2);

    return path;
}

juce::StringArray getMissingPackagedFrontendAssets()
{
    juce::StringArray missingAssets;
    const auto frontendEntryPoint = getPackagedFrontendEntryPoint();
    const auto frontendRoot = getPackagedFrontendRoot();

    if (! frontendEntryPoint.existsAsFile() || ! frontendRoot.isDirectory())
        return missingAssets;

    const auto html = frontendEntryPoint.loadFileAsString();
    const std::regex assetPattern(R"((?:src|href)\s*=\s*["']([^"'#][^"']*)["'])", std::regex::icase);
    const auto htmlText = html.toStdString();
    std::sregex_iterator begin(htmlText.begin(), htmlText.end(), assetPattern), end;
    juce::StringArray referencedAssets;

    for (auto it = begin; it != end; ++it)
    {
        const auto normalised = normaliseFrontendAssetPath(juce::String((*it)[1].str()));
        if (normalised.isNotEmpty())
            referencedAssets.addIfNotAlreadyThere(normalised);
    }

    for (const auto& referencedAsset : referencedAssets)
    {
        if (referencedAsset == "index.html")
            continue;

        const auto candidate = frontendRoot.getChildFile(referencedAsset);
        if (! candidate.existsAsFile() && ! candidate.isDirectory())
            missingAssets.add("frontend asset " + referencedAsset + " -> " + candidate.getFullPathName());
    }

    return missingAssets;
}

juce::StringArray getMissingShellRuntimeAssets()
{
    auto missingAssets = getMissingRuntimeAssets(getShellCriticalRuntimeAssetChecks());

    for (const auto& missingAsset : getMissingPackagedFrontendAssets())
        missingAssets.addIfNotAlreadyThere(missingAsset);

    return missingAssets;
}

juce::StringArray getMissingBundledFeatureAssets()
{
    return getMissingRuntimeAssets(getBundledFeatureAssetChecks());
}

juce::String normaliseResourceRequestPath(const juce::String& requestPath)
{
    auto path = requestPath.upToFirstOccurrenceOf("?", false, false)
                           .upToFirstOccurrenceOf("#", false, false)
                           .trim();

    const auto schemeMarker = path.indexOf("://");
    if (schemeMarker >= 0)
    {
        const auto afterScheme = path.substring(schemeMarker + 3);
        const auto firstPathSeparator = afterScheme.indexOfChar('/');
        path = firstPathSeparator >= 0 ? afterScheme.substring(firstPathSeparator + 1) : juce::String();
    }

    while (path.startsWithChar('/'))
        path = path.substring(1);

    path = juce::URL::removeEscapeChars(path).replaceCharacter('\\', '/');

    if (path.isEmpty())
        return "index.html";

    return path;
}

bool isSafeResourceRelativePath(const juce::String& path)
{
    if (path.isEmpty())
        return false;

    if (path.contains(".."))
        return false;

    if (path.startsWithChar('/'))
        return false;

    return true;
}

juce::String getMimeTypeForFrontendFile(const juce::File& file)
{
    const auto extension = file.getFileExtension().toLowerCase();

    if (extension == ".html")
        return "text/html";
    if (extension == ".js" || extension == ".mjs")
        return "application/javascript";
    if (extension == ".css")
        return "text/css";
    if (extension == ".json")
        return "application/json";
    if (extension == ".svg")
        return "image/svg+xml";
    if (extension == ".png")
        return "image/png";
    if (extension == ".jpg" || extension == ".jpeg")
        return "image/jpeg";
    if (extension == ".gif")
        return "image/gif";
    if (extension == ".ico")
        return "image/x-icon";
    if (extension == ".webp")
        return "image/webp";
    if (extension == ".woff2")
        return "font/woff2";
    if (extension == ".woff")
        return "font/woff";
    if (extension == ".ttf")
        return "font/ttf";
    if (extension == ".otf")
        return "font/otf";
    if (extension == ".webmanifest")
        return "application/manifest+json";

    return "application/octet-stream";
}

#if JUCE_WINDOWS
juce::String detectWebView2RuntimeVersion()
{
    const juce::Array<juce::File> roots {
        juce::File("C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application"),
        juce::File("C:\\Program Files\\Microsoft\\EdgeWebView\\Application")
    };

    juce::String bestVersion;

    for (const auto& root : roots)
    {
        if (!root.isDirectory())
            continue;

        for (const auto& child : root.findChildFiles(juce::File::findDirectories, false))
        {
            const auto version = child.getFileName();
            if (version.containsOnly("0123456789."))
            {
                if (bestVersion.isEmpty() || version.compareNatural(bestVersion) > 0)
                    bestVersion = version;
            }
        }
    }

    return bestVersion;
}

bool isVCRedistInstalled(juce::String* detectedVersion = nullptr)
{
    if (detectedVersion != nullptr)
        detectedVersion->clear();

    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE,
                      L"SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64",
                      0,
                      KEY_READ | KEY_WOW64_64KEY,
                      &key) != ERROR_SUCCESS)
    {
        return false;
    }

    DWORD installed = 0;
    DWORD installedSize = sizeof(installed);
    const auto installedStatus = RegQueryValueExW(key, L"Installed", nullptr, nullptr, reinterpret_cast<LPBYTE>(&installed), &installedSize);

    wchar_t versionBuffer[128] {};
    DWORD versionSize = sizeof(versionBuffer);
    if (detectedVersion != nullptr &&
        RegQueryValueExW(key, L"Version", nullptr, nullptr, reinterpret_cast<LPBYTE>(versionBuffer), &versionSize) == ERROR_SUCCESS)
    {
        *detectedVersion = juce::String(versionBuffer);
    }

    RegCloseKey(key);
    return installedStatus == ERROR_SUCCESS && installed == 1;
}

juce::File getWindowsPrerequisiteInstallerDirectory()
{
    return getRuntimeAssetRoot().getChildFile("prereqs").getChildFile("windows");
}

bool canRepairWindowsPrerequisites()
{
    const auto prereqDir = getWindowsPrerequisiteInstallerDirectory();
    return prereqDir.getChildFile("MicrosoftEdgeWebView2RuntimeInstallerX64.exe").existsAsFile()
        || prereqDir.getChildFile("vc_redist.x64.exe").existsAsFile();
}
#endif

juce::String getStringProperty(const juce::var& value, const juce::Identifier& property)
{
    if (auto* obj = value.getDynamicObject())
        return obj->getProperty(property).toString();

    return {};
}

struct StartupDependencyStatus
{
    bool packagedFrontendPresent = false;
    bool shellRuntimeAssetsPresent = true;
    bool featureRuntimeAssetsPresent = true;
    bool browserBackendSupported = false;
    bool repairAvailable = false;
    juce::String packagedFrontendPath;
    juce::String browserBackend;
    juce::StringArray missingShellRuntimeAssets;
    juce::StringArray missingFeatureRuntimeAssets;
#if JUCE_WINDOWS
    juce::String webView2RuntimeVersion;
    bool vcRedistInstalled = false;
    juce::String vcRedistVersion;
#endif
};

StartupDependencyStatus evaluateStartupDependencies(bool browserBackendSupported)
{
    StartupDependencyStatus status;
    status.browserBackendSupported = browserBackendSupported;
    status.packagedFrontendPresent = getPackagedFrontendEntryPoint().existsAsFile();
    status.packagedFrontendPath = getPackagedFrontendEntryPoint().getFullPathName();
    status.browserBackend = describeBrowserBackend(getPreferredBrowserBackend());
    status.missingShellRuntimeAssets = getMissingShellRuntimeAssets();
    status.shellRuntimeAssetsPresent = status.missingShellRuntimeAssets.isEmpty();
    status.missingFeatureRuntimeAssets = getMissingBundledFeatureAssets();
    status.featureRuntimeAssetsPresent = status.missingFeatureRuntimeAssets.isEmpty();

#if JUCE_WINDOWS
    status.webView2RuntimeVersion = detectWebView2RuntimeVersion();
    status.vcRedistInstalled = isVCRedistInstalled(&status.vcRedistVersion);
    status.repairAvailable = canRepairWindowsPrerequisites();
#endif

    return status;
}

juce::String formatMissingRuntimeAssets(const juce::StringArray& missingRuntimeAssets)
{
    juce::StringArray lines;
    for (const auto& entry : missingRuntimeAssets)
        lines.add(" - " + entry);
    return lines.joinIntoString("\n");
}

juce::String getDefaultFileFilter(const juce::String& defaultPath, const juce::String& explicitFilter, bool projectDialog)
{
    if (explicitFilter.isNotEmpty())
        return explicitFilter;

    const auto lowerPath = defaultPath.toLowerCase();

    if (lowerPath.endsWith(".ospreset") || lowerPath.endsWith(".s13preset") || lowerPath.endsWith(".s13nampreset"))
        return "*.ospreset;*.s13preset;*.s13nampreset";

    if (lowerPath.endsWith(".ostheme") || lowerPath.endsWith(".s13theme"))
        return "*.ostheme;*.s13theme;*.json";

    if (lowerPath.endsWith(".mid") || lowerPath.endsWith(".midi"))
        return "*.mid;*.midi";

    if (projectDialog)
        return "*.osproj;*.s13";

    return "*";
}

juce::String getPreferredExtension(const juce::String& defaultPath, const juce::String& filter)
{
    const auto lowerPath = defaultPath.toLowerCase();
    const auto lowerFilter = filter.toLowerCase();

    if (lowerPath.endsWith(".s13nampreset") || lowerFilter.contains(".s13nampreset"))
        return ".s13nampreset";

    if (lowerPath.endsWith(".ospreset") || lowerFilter.contains(".ospreset"))
        return ".ospreset";

    if (lowerPath.endsWith(".ostheme") || lowerFilter.contains(".ostheme"))
        return ".ostheme";

    if (lowerPath.endsWith(".mid") || lowerPath.endsWith(".midi")
        || lowerFilter.contains(".mid") || lowerFilter.contains(".midi"))
        return ".mid";

    return ".osproj";
}

#if JUCE_WINDOWS
juce::Rectangle<int> rectFromRECT(const RECT& r)
{
    return { r.left, r.top, r.right - r.left, r.bottom - r.top };
}

juce::Rectangle<int> getWindowRestoreBoundsFromPlacement(HWND hwnd)
{
    WINDOWPLACEMENT placement {};
    placement.length = sizeof(placement);
    if (::GetWindowPlacement(hwnd, &placement) != 0)
        return rectFromRECT(placement.rcNormalPosition);

    return {};
}
#endif

juce::String getWindowRoleQueryValue(MainComponent::WindowRole role)
{
    if (role == MainComponent::WindowRole::mixer)
        return "mixer";
    if (role == MainComponent::WindowRole::midiEditor)
        return "midiEditor";
    if (role == MainComponent::WindowRole::pluginEditor)
        return "pluginEditor";
    return "main";
}

juce::String getStartupModeQueryValue(MainComponent::StartupMode startupMode)
{
    return startupMode == MainComponent::StartupMode::safe ? "safe" : "normal";
}

juce::String getHostPlatformQueryValue()
{
#if JUCE_WINDOWS
    return "windows";
#elif JUCE_MAC
    return "macos";
#elif JUCE_LINUX
    return "linux";
#else
    return "unknown";
#endif
}

juce::String getWindowChromeQueryValue(MainComponent::WindowRole role)
{
    if (role == MainComponent::WindowRole::mixer
        || role == MainComponent::WindowRole::midiEditor
        || role == MainComponent::WindowRole::pluginEditor)
        return "native";

#if JUCE_MAC
    return "native";
#else
    return "custom";
#endif
}

juce::File getOpenStudioNAMRoot()
{
#if JUCE_MAC
    auto root = juce::File::getSpecialLocation(juce::File::userHomeDirectory)
        .getChildFile("Library")
        .getChildFile("Application Support")
        .getChildFile("OpenStudio")
        .getChildFile("NAM");
    const auto legacyRoot = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("OpenStudio")
        .getChildFile("NAM");
#elif JUCE_LINUX
    const auto xdgDataHome = juce::SystemStats::getEnvironmentVariable("XDG_DATA_HOME", {});
    auto root = xdgDataHome.isNotEmpty()
        ? juce::File(xdgDataHome).getChildFile("OpenStudio").getChildFile("NAM")
        : juce::File::getSpecialLocation(juce::File::userHomeDirectory)
              .getChildFile(".local")
              .getChildFile("share")
              .getChildFile("OpenStudio")
              .getChildFile("NAM");
    const auto legacyRoot = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("OpenStudio")
        .getChildFile("NAM");
#else
    auto root = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("OpenStudio")
        .getChildFile("NAM");
#endif

#if JUCE_MAC || JUCE_LINUX
    // Preserve pre-release data written before NAM adopted the platform data
    // directory. The Python catalog updater uses the same fallback.
    if (! root.exists() && legacyRoot.isDirectory())
        root = legacyRoot;
#endif

    root.createDirectory();
    root.getChildFile("library").createDirectory();
    root.getChildFile("previews").createDirectory();
    return root;
}

juce::File getOpenStudioNAMCatalogJson()
{
    return getOpenStudioNAMRoot().getChildFile("catalog.json");
}

juce::File getOpenStudioNAMCatalogSqlite()
{
    return getOpenStudioNAMRoot().getChildFile("catalog.sqlite");
}

juce::File getOpenStudioNAMManifestJson()
{
    return getOpenStudioNAMRoot().getChildFile("library_manifest.json");
}

// All MainComponent instances share one AudioEngine. These guards must therefore
// be process-wide rather than members of an individual editor window.
juce::CriticalSection namModelMutationStateLock;
juce::CriticalSection namModelMutationGenerationLock;
std::map<std::string, juce::uint64> namModelMutationGenerations;
juce::uint64 nextNAMModelMutationGeneration = 0;
juce::uint64 namRackTopologyGeneration = 1;
juce::CriticalSection namLibraryMutationLock;

void invalidateNAMRackTopology()
{
    const juce::ScopedLock generationLock(namModelMutationGenerationLock);
    ++namRackTopologyGeneration;
}

bool isNAMRackTopologyCurrent(juce::uint64 generation)
{
    const juce::ScopedLock generationLock(namModelMutationGenerationLock);
    return generation == namRackTopologyGeneration;
}

bool persistNAMLibraryManifest(const juce::var& manifest)
{
    const juce::ScopedLock manifestLock(namLibraryMutationLock);
    const auto manifestFile = getOpenStudioNAMManifestJson();
    juce::TemporaryFile temporaryManifest(manifestFile, juce::TemporaryFile::useHiddenFile);
    if (! temporaryManifest.getFile().replaceWithText(juce::JSON::toString(manifest, true)))
        return false;

    return temporaryManifest.overwriteTargetFileWithTemporary();
}

juce::File getTone3000TokenFile()
{
#if JUCE_WINDOWS
    return getOpenStudioNAMRoot().getChildFile("tone3000_tokens.dpapi");
#else
    return getOpenStudioNAMRoot().getChildFile("tone3000_tokens.json");
#endif
}

juce::File getTone3000PendingAuthFile()
{
#if JUCE_WINDOWS
    return getOpenStudioNAMRoot().getChildFile("tone3000_pending_auth.dpapi");
#else
    return getOpenStudioNAMRoot().getChildFile("tone3000_pending_auth.json");
#endif
}

constexpr int kTone3000LoopbackPort = 18762;
constexpr int kTone3000LoopbackTimeoutMs = 10 * 60 * 1000;
constexpr const char* kTone3000LoopbackHost = "127.0.0.1";
constexpr const char* kTone3000LoopbackPath = "/tone3000/callback";
constexpr const char* kTone3000DefaultRedirectUri = "http://127.0.0.1:18762/tone3000/callback";

std::atomic<int> tone3000AuthFlowGeneration { 0 };
std::atomic<bool> tone3000AuthFlowActive { false };

juce::String getConfiguredTone3000ClientId()
{
    return juce::String(OPENSTUDIO_TONE3000_CLIENT_ID).trim().unquoted();
}

juce::String getTone3000OptionString(juce::DynamicObject* options,
                                     const juce::Identifier& key,
                                     const juce::String& fallback = {})
{
    if (options == nullptr || ! options->hasProperty(key))
        return fallback;

    return options->getProperty(key).toString().trim();
}

int getTone3000OptionInt(juce::DynamicObject* options,
                         const juce::Identifier& key,
                         int fallback)
{
    if (options == nullptr || ! options->hasProperty(key))
        return fallback;

    return static_cast<int> (options->getProperty(key));
}

juce::var makeTone3000AuthFlowResult(const juce::String& status,
                                     bool success,
                                     const juce::String& error = {},
                                     const juce::String& authUrl = {},
                                     const juce::String& toneId = {},
                                     bool fallbackRequired = false)
{
    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", success);
    result->setProperty("status", status);
    result->setProperty("defaultRedirectUri", kTone3000DefaultRedirectUri);
    result->setProperty("configuredClientId", getConfiguredTone3000ClientId().isNotEmpty());
    if (error.isNotEmpty())
        result->setProperty("error", error);
    if (authUrl.isNotEmpty())
        result->setProperty("authUrl", authUrl);
    if (toneId.isNotEmpty())
        result->setProperty("toneId", toneId);
    if (fallbackRequired)
        result->setProperty("fallbackRequired", true);
    return juce::var(result.get());
}

juce::StringPairArray parseTone3000QueryString(juce::String query)
{
    if (query.startsWithChar('?'))
        query = query.substring(1);

    juce::StringPairArray params;
    juce::StringArray pairs;
    pairs.addTokens(query, "&", {});

    for (const auto& pair : pairs)
    {
        const auto equals = pair.indexOfChar('=');
        const auto rawKey = equals >= 0 ? pair.substring(0, equals) : pair;
        const auto rawValue = equals >= 0 ? pair.substring(equals + 1) : juce::String();
        auto key = juce::URL::removeEscapeChars(rawKey.replaceCharacter('+', ' ')).trim();
        auto value = juce::URL::removeEscapeChars(rawValue.replaceCharacter('+', ' ')).trim();
        if (key.isNotEmpty())
            params.set(key, value);
    }

    return params;
}

bool writeTone3000SocketText(juce::StreamingSocket& socket,
                             const juce::String& text,
                             int timeoutMs)
{
    auto bytesWritten = 0;
    const auto totalBytes = static_cast<int> (text.getNumBytesAsUTF8());
    const auto* data = text.toRawUTF8();
    const auto deadline = juce::Time::currentTimeMillis() + timeoutMs;

    while (bytesWritten < totalBytes && juce::Time::currentTimeMillis() < deadline)
    {
        if (socket.waitUntilReady(false, 250) <= 0)
            continue;

        const auto chunk = socket.write(data + bytesWritten, totalBytes - bytesWritten);
        if (chunk <= 0)
            return false;

        bytesWritten += chunk;
    }

    return bytesWritten == totalBytes;
}

juce::String escapeTone3000Html(juce::String text)
{
    return text.replace("&", "&amp;")
               .replace("<", "&lt;")
               .replace(">", "&gt;")
               .replace("\"", "&quot;")
               .replace("'", "&#39;");
}

void writeTone3000CallbackPage(juce::StreamingSocket& socket,
                               const juce::String& title,
                               const juce::String& detail,
                               bool ok)
{
    const auto status = ok ? juce::String("200 OK") : juce::String("400 Bad Request");
    const auto safeTitle = escapeTone3000Html(title);
    const auto safeDetail = escapeTone3000Html(detail);
    juce::String html;
    html << "<!doctype html><html><head><meta charset=\"utf-8\">"
         << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
         << "<title>OpenStudio TONE3000</title>"
         << "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;"
         << "font-family:Segoe UI,Arial,sans-serif;background:#111;color:#f8fafc}"
         << "main{max-width:560px;padding:32px}h1{font-size:24px;margin:0 0 10px}"
         << "p{line-height:1.5;color:#cbd5e1}</style></head><body><main>"
         << "<h1>" << safeTitle << "</h1><p>" << safeDetail << "</p></main></body></html>";

    juce::String response;
    response << "HTTP/1.1 " << status << "\r\n"
             << "Content-Type: text/html; charset=utf-8\r\n"
             << "Content-Length: " << static_cast<int> (html.getNumBytesAsUTF8()) << "\r\n"
             << "Connection: close\r\n\r\n"
             << html;
    writeTone3000SocketText(socket, response, 3000);
}

juce::String readTone3000HttpRequest(juce::StreamingSocket& socket, int timeoutMs)
{
    juce::MemoryOutputStream stream;
    char buffer[1024] {};
    const auto deadline = juce::Time::currentTimeMillis() + timeoutMs;

    while (stream.getDataSize() < 16384 && juce::Time::currentTimeMillis() < deadline)
    {
        if (socket.waitUntilReady(true, 250) <= 0)
            continue;

        const auto bytesRead = socket.read(buffer, static_cast<int> (sizeof(buffer)), false);
        if (bytesRead <= 0)
            break;

        stream.write(buffer, static_cast<size_t> (bytesRead));
        const auto text = juce::String::fromUTF8(static_cast<const char*> (stream.getData()), static_cast<int> (stream.getDataSize()));
        if (text.contains("\r\n\r\n"))
            return text;
    }

    return juce::String::fromUTF8(static_cast<const char*> (stream.getData()), static_cast<int> (stream.getDataSize()));
}

juce::File findOpenStudioNAMCatalogUpdaterScript()
{
    const auto appDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
    const auto cwd = juce::File::getCurrentWorkingDirectory();

    juce::Array<juce::File> candidates;
    candidates.add(cwd.getChildFile("tools").getChildFile("update_nam_catalog.py"));
    candidates.add(appDir.getChildFile("scripts").getChildFile("update_nam_catalog.py"));
    candidates.add(appDir.getParentDirectory().getChildFile("scripts").getChildFile("update_nam_catalog.py"));
    candidates.add(appDir.getParentDirectory().getParentDirectory().getChildFile("scripts").getChildFile("update_nam_catalog.py"));
    candidates.add(appDir.getParentDirectory().getParentDirectory().getParentDirectory().getChildFile("tools").getChildFile("update_nam_catalog.py"));

    for (const auto& candidate : candidates)
        if (candidate.existsAsFile())
            return candidate;

    return {};
}

juce::String findOpenStudioPythonForNAMCatalog()
{
    const auto appDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
    const auto cwd = juce::File::getCurrentWorkingDirectory();

    juce::Array<juce::File> candidates;
#if JUCE_WINDOWS
    candidates.add(cwd.getChildFile("tools").getChildFile("python").getChildFile("python.exe"));
    candidates.add(appDir.getChildFile("python").getChildFile("python.exe"));
    candidates.add(appDir.getParentDirectory().getChildFile("tools").getChildFile("python").getChildFile("python.exe"));
    candidates.add(appDir.getParentDirectory().getParentDirectory().getChildFile("tools").getChildFile("python").getChildFile("python.exe"));
    candidates.add(appDir.getParentDirectory().getParentDirectory().getParentDirectory().getChildFile("tools").getChildFile("python").getChildFile("python.exe"));
#else
    candidates.add(cwd.getChildFile("tools").getChildFile("python").getChildFile("bin").getChildFile("python3"));
    candidates.add(appDir.getChildFile("python").getChildFile("bin").getChildFile("python3"));
#endif

    for (const auto& candidate : candidates)
        if (candidate.existsAsFile())
            return candidate.getFullPathName();

#if JUCE_WINDOWS
    return "python";
#else
    return "python3";
#endif
}

juce::String base64UrlEncode(const void* data, size_t size)
{
    auto text = juce::Base64::toBase64(data, size);
    text = text.replace("+", "-").replace("/", "_");
    return text.trimCharactersAtEnd("=");
}

juce::String makeTone3000FormBody(const juce::StringPairArray& values)
{
    juce::String body;
    const auto keys = values.getAllKeys();
    const auto allValues = values.getAllValues();
    for (int i = 0; i < values.size(); ++i)
    {
        if (i > 0)
            body << "&";
        body << juce::URL::addEscapeChars(keys[i], true)
             << "="
             << juce::URL::addEscapeChars(allValues[i], true);
    }
    return body;
}

juce::String makeTone3000CodeVerifier()
{
    auto verifier = (juce::Uuid().toString() + juce::Uuid().toString() + juce::Uuid().toString())
        .replace("-", "")
        .replace("{", "")
        .replace("}", "");
    return verifier.substring(0, 96);
}

juce::String makeTone3000CodeChallenge(const juce::String& verifier)
{
    juce::MemoryBlock verifierData(verifier.toRawUTF8(), verifier.getNumBytesAsUTF8());
    const auto hash = juce::SHA256(verifierData).getRawData();
    return base64UrlEncode(hash.getData(), hash.getSize());
}

bool saveProtectedText(const juce::File& file, const juce::String& text, juce::String& error)
{
    const auto directoryResult = file.getParentDirectory().createDirectory();
    if (directoryResult.failed())
    {
        error = "Could not create the private TONE3000 session directory";
        return false;
    }

#if JUCE_WINDOWS
    juce::MemoryBlock plain(text.toRawUTF8(), text.getNumBytesAsUTF8());
    DATA_BLOB input {};
    input.pbData = static_cast<BYTE*>(plain.getData());
    input.cbData = static_cast<DWORD>(plain.getSize());

    DATA_BLOB output {};
    if (!::CryptProtectData(&input, L"OpenStudio TONE3000", nullptr, nullptr, nullptr,
                            CRYPTPROTECT_UI_FORBIDDEN, &output))
    {
        error = "DPAPI encryption failed";
        return false;
    }

    juce::TemporaryFile temporaryFile(file, juce::TemporaryFile::useHiddenFile);
    const bool wroteTemporary = temporaryFile.getFile().replaceWithData(output.pbData, output.cbData);
    ::LocalFree(output.pbData);
    if (! wroteTemporary || ! temporaryFile.overwriteTargetFileWithTemporary())
    {
        error = "Could not write encrypted token file";
        return false;
    }
    return true;
#else
    juce::TemporaryFile temporaryFile(file, juce::TemporaryFile::useHiddenFile);
    if (! temporaryFile.getFile().replaceWithText(text))
    {
        error = "Could not write the private TONE3000 session file";
        return false;
    }

    const auto temporaryPath = temporaryFile.getFile().getFullPathName();
    if (::chmod(temporaryPath.toRawUTF8(), S_IRUSR | S_IWUSR) != 0)
    {
        error = "Could not restrict permissions on the private TONE3000 session file";
        return false;
    }

    if (! temporaryFile.overwriteTargetFileWithTemporary())
    {
        error = "Could not publish the private TONE3000 session file";
        return false;
    }

    const auto targetPath = file.getFullPathName();
    if (::chmod(targetPath.toRawUTF8(), S_IRUSR | S_IWUSR) != 0)
    {
        file.deleteFile();
        error = "Could not restrict permissions on the private TONE3000 session file";
        return false;
    }
    return true;
#endif
}

juce::String loadProtectedText(const juce::File& file, juce::String& error)
{
    if (!file.existsAsFile())
        return {};

#if JUCE_WINDOWS
    juce::MemoryBlock encrypted;
    if (!file.loadFileAsData(encrypted) || encrypted.getSize() == 0)
    {
        error = "Encrypted token file is empty";
        return {};
    }

    DATA_BLOB input {};
    input.pbData = static_cast<BYTE*>(encrypted.getData());
    input.cbData = static_cast<DWORD>(encrypted.getSize());

    DATA_BLOB output {};
    if (!::CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr,
                              CRYPTPROTECT_UI_FORBIDDEN, &output))
    {
        error = "DPAPI decryption failed";
        return {};
    }

    const juce::String text = juce::String::fromUTF8(reinterpret_cast<const char*>(output.pbData),
                                                    static_cast<int>(output.cbData));
    ::LocalFree(output.pbData);
    return text;
#else
    const auto text = file.loadFileAsString();
    if (text.isEmpty())
        error = "Private TONE3000 session file is empty";
    return text;
#endif
}

juce::var loadProtectedJson(const juce::File& file, juce::String& error)
{
    const auto text = loadProtectedText(file, error);
    if (text.isEmpty())
        return {};

    auto parsed = juce::JSON::parse(text);
    if (parsed.isVoid())
        error = "Stored TONE3000 token JSON is invalid";
    return parsed;
}

bool saveProtectedJson(const juce::File& file, const juce::var& payload, juce::String& error)
{
    return saveProtectedText(file, juce::JSON::toString(payload, false), error);
}

juce::var makeTone3000Error(const juce::String& message, int statusCode = 0)
{
    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", false);
    result->setProperty("error", message);
    if (statusCode > 0)
        result->setProperty("statusCode", statusCode);
    return juce::var(result.get());
}

juce::var postTone3000OAuthToken(const juce::StringPairArray& fields)
{
    int statusCode = 0;
    auto tokenUrl = juce::URL("https://www.tone3000.com/api/v1/oauth/token")
        .withPOSTData(makeTone3000FormBody(fields));
    auto input = tokenUrl.createInputStream(
        juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
            .withHttpRequestCmd("POST")
            .withExtraHeaders("Content-Type: application/x-www-form-urlencoded\r\n")
            .withConnectionTimeoutMs(30000)
            .withNumRedirectsToFollow(2)
            .withStatusCode(&statusCode));

    if (input == nullptr)
        return makeTone3000Error("TONE3000 token request failed", statusCode);

    const auto responseText = input->readEntireStreamAsString();
    auto parsed = juce::JSON::parse(responseText);
    if (parsed.isVoid())
        return makeTone3000Error("TONE3000 token response was not valid JSON", statusCode);

    if (statusCode >= 400)
    {
        auto* errorObject = parsed.getDynamicObject();
        juce::String message = "Token request failed";
        juce::String oauthError;
        juce::String oauthDescription;
        if (errorObject != nullptr)
        {
            oauthDescription = errorObject->getProperty("error_description").toString();
            oauthError = errorObject->getProperty("error").toString();
            message = oauthDescription;
            if (message.isEmpty())
                message = oauthError;
            if (message.isEmpty())
                message = "Token request failed";
        }
        auto result = makeTone3000Error(message, statusCode);
        if (auto* resultObject = result.getDynamicObject())
        {
            if (oauthError.isNotEmpty())
                resultObject->setProperty("oauthError", oauthError);
            if (oauthDescription.isNotEmpty())
                resultObject->setProperty("oauthErrorDescription", oauthDescription);
        }
        return result;
    }

    return parsed;
}

juce::var storeTone3000TokenPayload(juce::var tokenPayload, const juce::String& clientId)
{
    auto* tokenObject = tokenPayload.getDynamicObject();
    if (tokenObject == nullptr)
        return makeTone3000Error("Invalid TONE3000 token payload");

    const auto accessToken = tokenObject->getProperty("access_token").toString();
    const auto refreshToken = tokenObject->getProperty("refresh_token").toString();
    if (accessToken.isEmpty())
        return makeTone3000Error("TONE3000 did not return an access token");

    const auto expiresIn = static_cast<juce::int64>(static_cast<double>(tokenObject->getProperty("expires_in")));
    const auto expiresAtMs = juce::Time::getCurrentTime().toMilliseconds()
        + juce::jmax<juce::int64>(0, expiresIn) * 1000;

    juce::DynamicObject::Ptr stored = new juce::DynamicObject();
    stored->setProperty("schemaVersion", 1);
    stored->setProperty("provider", "tone3000");
    stored->setProperty("clientId", clientId);
    stored->setProperty("accessToken", accessToken);
    stored->setProperty("refreshToken", refreshToken);
    stored->setProperty("tokenType", tokenObject->hasProperty("token_type")
        ? tokenObject->getProperty("token_type")
        : juce::var("bearer"));
    stored->setProperty("scope", tokenObject->hasProperty("scope")
        ? tokenObject->getProperty("scope")
        : juce::var());
    stored->setProperty("expiresAtMs", static_cast<double>(expiresAtMs));
    stored->setProperty("storedAt", juce::Time::getCurrentTime().toISO8601(true));

    juce::String error;
    if (!saveProtectedJson(getTone3000TokenFile(), juce::var(stored.get()), error))
        return makeTone3000Error(error);

    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", true);
    result->setProperty("authenticated", true);
    result->setProperty("expired", false);
    result->setProperty("clientId", clientId);
    result->setProperty("expiresAtMs", static_cast<double>(expiresAtMs));
    result->setProperty("hasRefreshToken", refreshToken.isNotEmpty());
    return juce::var(result.get());
}

juce::var makeTone3000AuthStatus()
{
    juce::String error;
    auto stored = loadProtectedJson(getTone3000TokenFile(), error);
    juce::DynamicObject::Ptr status = new juce::DynamicObject();
    status->setProperty("success", true);
    status->setProperty("authenticated", false);
    status->setProperty("configuredClientId", getConfiguredTone3000ClientId().isNotEmpty());
    status->setProperty("defaultRedirectUri", kTone3000DefaultRedirectUri);
    status->setProperty("authFlowActive", tone3000AuthFlowActive.load());

    if (auto* object = stored.getDynamicObject())
    {
        const auto expiresAtMs = static_cast<juce::int64>(static_cast<double>(object->getProperty("expiresAtMs")));
        const auto nowMs = juce::Time::getCurrentTime().toMilliseconds();
        status->setProperty("authenticated", object->getProperty("accessToken").toString().isNotEmpty());
        status->setProperty("expired", expiresAtMs > 0 && nowMs >= expiresAtMs);
        status->setProperty("expiresAtMs", static_cast<double>(expiresAtMs));
        status->setProperty("clientId", object->getProperty("clientId"));
        status->setProperty("hasRefreshToken", object->getProperty("refreshToken").toString().isNotEmpty());
    }
    else if (error.isNotEmpty())
    {
        status->setProperty("error", error);
    }

    const bool authenticated = static_cast<bool>(status->getProperty("authenticated"));
    const bool expired = static_cast<bool>(status->getProperty("expired"));
    const bool configured = static_cast<bool>(status->getProperty("configuredClientId"))
        || status->getProperty("clientId").toString().isNotEmpty();
    status->setProperty("integrationState",
        authenticated && ! expired ? "authenticated"
        : authenticated && expired ? "expired"
        : configured ? "configured_unauthenticated"
        : "client_id_required");
    status->setProperty("authenticatedQAReady", authenticated && ! expired);
    status->setProperty("authenticatedQANote", authenticated && ! expired
        ? "Authenticated TONE3000 integration checks may run without exposing the stored token."
        : "Authenticated TONE3000 QA requires a user-connected, non-expired session.");
    status->setProperty("oauthRedirectUri", kTone3000DefaultRedirectUri);
    status->setProperty("oauthProvider", "tone3000.com");
#if JUCE_WINDOWS
    status->setProperty("secureTokenStorage", "windows-dpapi");
#else
    status->setProperty("secureTokenStorage", "user-private-file");
#endif

    return juce::var(status.get());
}

juce::String getStoredTone3000AccessToken()
{
    juce::String error;
    auto stored = loadProtectedJson(getTone3000TokenFile(), error);
    if (auto* object = stored.getDynamicObject())
    {
        const auto expiresAtMs = static_cast<juce::int64>(static_cast<double>(object->getProperty("expiresAtMs")));
        if (expiresAtMs <= 0 || juce::Time::getCurrentTime().toMilliseconds() < expiresAtMs)
            return object->getProperty("accessToken").toString();
    }
    return {};
}

juce::String getModelObjectString(juce::DynamicObject* model,
                                  const juce::String& primary,
                                  const juce::String& fallback = {});

int getModelObjectInt(juce::DynamicObject* model,
                      const juce::String& primary,
                      const juce::String& fallback = {});

bool isTone3000ErrorPayload(const juce::var& payload)
{
    if (auto* object = payload.getDynamicObject())
        return object->hasProperty("error") && static_cast<bool>(object->getProperty("success")) == false;

    return false;
}

juce::var makeTone3000Success()
{
    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", true);
    return juce::var(result.get());
}

juce::var getTone3000Json(juce::URL url, const juce::String& accessToken, const juce::String& label)
{
    if (accessToken.isEmpty())
        return makeTone3000Error("Missing TONE3000 access token");
    if (accessToken.containsAnyOf("\r\n"))
        return makeTone3000Error("The TONE3000 access token contains invalid header characters");

    int statusCode = 0;
    juce::String headers;
    headers << "Authorization: Bearer " << accessToken << "\r\n"
            << "Content-Type: application/json\r\n";

    auto input = url.createInputStream(
        juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
            .withExtraHeaders(headers)
            .withConnectionTimeoutMs(30000)
            .withNumRedirectsToFollow(2)
            .withStatusCode(&statusCode));

    if (input == nullptr)
        return makeTone3000Error(label + " failed", statusCode);

    const auto responseText = input->readEntireStreamAsString();
    auto parsed = juce::JSON::parse(responseText);
    if (parsed.isVoid())
        return makeTone3000Error(label + " response was not valid JSON", statusCode);

    if (statusCode >= 400)
    {
        auto* errorObject = parsed.getDynamicObject();
        juce::String message = label + " failed";
        if (statusCode == 401)
            message = "TONE3000 authentication expired. Refresh or reconnect.";
        else if (statusCode == 429)
            message = "TONE3000 rate limit reached. Wait a minute before searching again.";

        if (errorObject != nullptr)
        {
            const auto description = errorObject->getProperty("error_description").toString();
            const auto error = errorObject->getProperty("error").toString();
            if (description.isNotEmpty())
                message = description;
            else if (error.isNotEmpty() && statusCode != 429)
                message = error;
        }

        auto result = makeTone3000Error(message, statusCode);
        if (auto* resultObject = result.getDynamicObject())
            resultObject->setProperty("response", parsed);
        return result;
    }

    return parsed;
}

juce::String normaliseTone3000Architecture(juce::String architecture)
{
    architecture = architecture.trim().toLowerCase();
    if (architecture == "a1")
        return "1";
    if (architecture == "a2")
        return "2";
    if (architecture == "1" || architecture == "2" || architecture == "custom")
        return architecture;
    return {};
}

juce::StringArray makeTone3000ArchitectureRequests(const juce::String& architecture)
{
    const auto normalised = normaliseTone3000Architecture(architecture);
    juce::StringArray architectures;
    if (normalised.isNotEmpty())
    {
        architectures.add(normalised);
        return architectures;
    }

    architectures.add("2");
    architectures.add("1");
    return architectures;
}

juce::String normaliseTone3000Sort(juce::String sort)
{
    sort = sort.trim().toLowerCase();
    if (sort == "newest" || sort == "oldest" || sort == "trending" || sort == "downloads-all-time" || sort == "best-match")
        return sort;
    if (sort == "latest")
        return "newest";
    if (sort == "downloaded")
        return "downloads-all-time";
    return "trending";
}

juce::String normaliseTone3000Gears(juce::String gears)
{
    gears = gears.trim().toLowerCase();
    return gears.replace(",", "_");
}

juce::var fetchTone3000ModelsForTone(int toneId,
                                     const juce::StringArray& architectures,
                                     const juce::String& accessToken,
                                     int modelPageSize,
                                     juce::Array<juce::var>& errors)
{
    juce::Array<juce::var> models;
    juce::Array<int> seenModelIds;

    for (const auto& architecture : architectures)
    {
        auto url = juce::URL("https://www.tone3000.com/api/v1/models")
            .withParameter("tone_id", juce::String(toneId))
            .withParameter("page", "1")
            .withParameter("page_size", juce::String(juce::jlimit(1, 100, modelPageSize)));
        if (architecture.isNotEmpty())
            url = url.withParameter("architecture", architecture);

        auto payload = getTone3000Json(url, accessToken, "TONE3000 model list");
        if (isTone3000ErrorPayload(payload))
        {
            errors.add(payload);
            continue;
        }

        if (auto* payloadObject = payload.getDynamicObject())
        {
            const auto data = payloadObject->getProperty("data");
            if (auto* array = data.getArray())
            {
                for (auto modelVar : *array)
                {
                    if (auto* model = modelVar.getDynamicObject())
                    {
                        const int modelId = getModelObjectInt(model, "id", "model_id");
                        if (modelId > 0 && seenModelIds.contains(modelId))
                            continue;

                        if (modelId > 0)
                            seenModelIds.add(modelId);

                        model->setProperty("architecture", model->getProperty("architecture_version"));
                        models.add(modelVar);
                    }
                }
            }
        }
    }

    return juce::var(models);
}

juce::var searchTone3000NAM(juce::var optionsPayload)
{
    if (optionsPayload.isString())
        optionsPayload = juce::JSON::parse(optionsPayload.toString());

    auto* options = optionsPayload.getDynamicObject();
    const auto accessToken = getStoredTone3000AccessToken();
    if (accessToken.isEmpty())
        return makeTone3000Error("Connect TONE3000 or refresh the stored token before live search");

    const auto query = options != nullptr ? getModelObjectString(options, "query") : juce::String();
    const auto sort = normaliseTone3000Sort(options != nullptr ? getModelObjectString(options, "sort") : juce::String());
    const auto gears = normaliseTone3000Gears(options != nullptr ? getModelObjectString(options, "gears") : juce::String("amp_amp-cab"));
    auto format = options != nullptr ? getModelObjectString(options, "format") : juce::String();
    if (format.isEmpty() && options != nullptr)
        format = getModelObjectString(options, "platform");
    format = format.trim().toLowerCase();
    if (format.isEmpty())
        format = "nam";
    const auto architecture = options != nullptr ? getModelObjectString(options, "architecture") : juce::String();
    const int page = juce::jmax(1, options != nullptr ? getModelObjectInt(options, "page") : 1);
    const int pageSize = juce::jlimit(1, 25, options != nullptr ? getModelObjectInt(options, "page_size", "pageSize") : 25);
    const int modelPageSize = juce::jlimit(1, 100, options != nullptr ? getModelObjectInt(options, "model_page_size", "modelPageSize") : 20);
    const bool includeModels = options == nullptr || !options->hasProperty("includeModels") || static_cast<bool>(options->getProperty("includeModels"));
    auto architectures = makeTone3000ArchitectureRequests(architecture);
    if (format == "ir")
    {
        architectures.clear();
        architectures.add(juce::String());
    }

    juce::Array<juce::var> tones;
    juce::Array<juce::var> errors;
    juce::Array<int> seenToneIds;
    int total = 0;
    int totalPages = 1;

    for (const auto& architectureRequest : architectures)
    {
        auto url = juce::URL("https://www.tone3000.com/api/v1/tones/search")
            .withParameter("query", query)
            .withParameter("page", juce::String(page))
            .withParameter("page_size", juce::String(pageSize))
            .withParameter("sort", sort)
            .withParameter("format", format);
        if (gears.isNotEmpty())
            url = url.withParameter("gears", gears);
        if (architectureRequest.isNotEmpty())
            url = url.withParameter("architecture", architectureRequest);

        auto payload = getTone3000Json(url, accessToken, "TONE3000 tone search");
        if (isTone3000ErrorPayload(payload))
            return payload;

        if (auto* payloadObject = payload.getDynamicObject())
        {
            total += static_cast<int>(payloadObject->getProperty("total"));
            totalPages = juce::jmax(totalPages, static_cast<int>(payloadObject->getProperty("total_pages")));
            const auto data = payloadObject->getProperty("data");
            if (auto* array = data.getArray())
            {
                for (auto toneVar : *array)
                {
                    if (auto* tone = toneVar.getDynamicObject())
                    {
                        const int toneId = getModelObjectInt(tone, "id");
                        if (toneId > 0 && seenToneIds.contains(toneId))
                            continue;

                        if (toneId > 0)
                            seenToneIds.add(toneId);

                        tone->setProperty("source", "tone3000-live");
                        tone->setProperty("sortBucket", sort);
                        tone->setProperty("searchArchitecture", architectureRequest);
                        tones.add(toneVar);
                    }
                }
            }
        }
    }

    if (includeModels)
    {
        for (auto& toneVar : tones)
        {
            if (auto* tone = toneVar.getDynamicObject())
            {
                const int toneId = getModelObjectInt(tone, "id");
                if (toneId > 0)
                    tone->setProperty("models", fetchTone3000ModelsForTone(toneId, architectures, accessToken, modelPageSize, errors));
            }
        }
    }

    auto result = makeTone3000Success();
    if (auto* object = result.getDynamicObject())
    {
        object->setProperty("data", tones);
        object->setProperty("tones", tones);
        object->setProperty("errors", errors);
        object->setProperty("page", page);
        object->setProperty("page_size", pageSize);
        object->setProperty("pageSize", pageSize);
        object->setProperty("total", total);
        object->setProperty("total_pages", totalPages);
        object->setProperty("totalPages", totalPages);
        object->setProperty("has_more", page < totalPages);
        object->setProperty("hasMore", page < totalPages);
        object->setProperty("next_page", page < totalPages ? juce::var(page + 1) : juce::var());
        object->setProperty("nextPage", page < totalPages ? juce::var(page + 1) : juce::var());
        object->setProperty("query", query);
        object->setProperty("sort", sort);
        object->setProperty("gears", gears);
        object->setProperty("format", format);
        object->setProperty("architecture", architecture.isNotEmpty() ? architecture : juce::String("all"));
        object->setProperty("source", "tone3000-live");
        object->setProperty("generatedAt", juce::Time::getCurrentTime().toISO8601(true));
        object->setProperty("rateLimit", "100 requests per minute default; search manually and avoid bulk refreshes");
    }
    return result;
}

juce::var runTone3000AuthenticatedQA()
{
    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", false);
    result->setProperty("provider", "tone3000.com");
    result->setProperty("checkedAt", juce::Time::getCurrentTime().toISO8601(true));

    const auto authStatus = makeTone3000AuthStatus();
    auto* authObject = authStatus.getDynamicObject();
    const bool qaReady = authObject != nullptr
        && static_cast<bool>(authObject->getProperty("authenticatedQAReady"));
    result->setProperty("authenticatedQAReady", qaReady);
    result->setProperty("integrationState", authObject != nullptr
        ? authObject->getProperty("integrationState")
        : juce::var("status_unavailable"));
    if (! qaReady)
    {
        result->setProperty("status", "not_run");
        result->setProperty("error", "Connect a non-expired TONE3000 account before running authenticated integration QA.");
        return juce::var(result.get());
    }

    juce::DynamicObject::Ptr options = new juce::DynamicObject();
    options->setProperty("query", "amp");
    options->setProperty("page", 1);
    options->setProperty("page_size", 1);
    options->setProperty("architecture", "1");
    options->setProperty("gears", "");
    options->setProperty("includeModels", false);
    const auto probe = searchTone3000NAM(juce::var(options.get()));
    auto* probeObject = probe.getDynamicObject();
    const bool success = probeObject != nullptr
        && static_cast<bool>(probeObject->getProperty("success"));
    result->setProperty("success", success);
    result->setProperty("status", success ? "pass" : "fail");
    if (probeObject != nullptr)
    {
        result->setProperty("statusCode", probeObject->getProperty("statusCode"));
        result->setProperty("error", probeObject->getProperty("error"));
        const auto tonesVar = probeObject->getProperty("tones");
        result->setProperty("returnedToneCount", tonesVar.isArray() ? tonesVar.getArray()->size() : 0);
    }
    return juce::var(result.get());
}

juce::var getTone3000ToneDetail(int toneId, const juce::String& architecture)
{
    const auto accessToken = getStoredTone3000AccessToken();
    if (accessToken.isEmpty())
        return makeTone3000Error("Connect TONE3000 or refresh the stored token before loading tone detail");
    if (toneId <= 0)
        return makeTone3000Error("Missing TONE3000 tone ID");

    auto architectures = makeTone3000ArchitectureRequests(architecture);
    if (architecture.trim().isEmpty())
    {
        architectures.clear();
        architectures.add(juce::String());
    }
    auto url = juce::URL("https://www.tone3000.com/api/v1/tones/" + juce::String(toneId));
    if (architectures.size() == 1 && architectures[0].isNotEmpty())
        url = url.withParameter("architecture", architectures[0]);

    auto tone = getTone3000Json(url, accessToken, "TONE3000 tone detail");
    if (isTone3000ErrorPayload(tone))
        return tone;

    juce::Array<juce::var> errors;
    auto result = makeTone3000Success();
    if (auto* object = result.getDynamicObject())
    {
        object->setProperty("tone", tone);
        object->setProperty("models", fetchTone3000ModelsForTone(toneId, architectures, accessToken, 100, errors));
        object->setProperty("errors", errors);
    }
    return result;
}

juce::var createTone3000AuthRequest(const juce::String& clientId,
                                    const juce::String& redirectUri,
                                    const juce::String& prompt,
                                    const juce::String& toneId,
                                    const juce::String& loginHint)
{
    if (clientId.trim().isEmpty())
        return makeTone3000Error("Missing TONE3000 client_id");
    if (redirectUri.trim().isEmpty())
        return makeTone3000Error("Missing OAuth redirect_uri");

    const auto verifier = makeTone3000CodeVerifier();
    const auto challenge = makeTone3000CodeChallenge(verifier);
    const auto state = juce::Uuid().toString();

    juce::URL authUrl("https://www.tone3000.com/api/v1/oauth/authorize");
    authUrl = authUrl.withParameter("client_id", clientId.trim())
        .withParameter("redirect_uri", redirectUri.trim())
        .withParameter("response_type", "code")
        .withParameter("code_challenge", challenge)
        .withParameter("code_challenge_method", "S256")
        .withParameter("state", state)
        .withParameter("platform", "nam")
        .withParameter("gears", "amp_amp-cab")
        .withParameter("architecture", "2")
        .withParameter("menubar", "true");
    if (prompt.isNotEmpty())
        authUrl = authUrl.withParameter("prompt", prompt);
    if (toneId.isNotEmpty())
        authUrl = authUrl.withParameter("tone_id", toneId);
    if (loginHint.isNotEmpty())
        authUrl = authUrl.withParameter("login_hint", loginHint);

    juce::DynamicObject::Ptr pending = new juce::DynamicObject();
    pending->setProperty("schemaVersion", 1);
    pending->setProperty("clientId", clientId.trim());
    pending->setProperty("redirectUri", redirectUri.trim());
    pending->setProperty("codeVerifier", verifier);
    pending->setProperty("state", state);
    pending->setProperty("createdAtMs", static_cast<double>(juce::Time::getCurrentTime().toMilliseconds()));
    pending->setProperty("createdAt", juce::Time::getCurrentTime().toISO8601(true));

    juce::String error;
    if (!saveProtectedJson(getTone3000PendingAuthFile(), juce::var(pending.get()), error))
        return makeTone3000Error(error);

    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", true);
    result->setProperty("authUrl", authUrl.toString(true));
    result->setProperty("state", state);
    result->setProperty("redirectUri", redirectUri.trim());
    result->setProperty("clientId", clientId.trim());
    return juce::var(result.get());
}

juce::var exchangeTone3000OAuthCode(const juce::String& code,
                                    const juce::String& stateFromCallback,
                                    const juce::String& clientIdOverride,
                                    const juce::String& redirectUriOverride)
{
    if (code.trim().isEmpty())
        return makeTone3000Error("Missing OAuth code");

    juce::String error;
    auto pending = loadProtectedJson(getTone3000PendingAuthFile(), error);
    auto* pendingObject = pending.getDynamicObject();
    if (pendingObject == nullptr)
        return makeTone3000Error(error.isNotEmpty() ? error : "No pending TONE3000 OAuth request");

    const auto createdAtMs = static_cast<juce::int64>(
        static_cast<double>(pendingObject->getProperty("createdAtMs")));
    const auto requestAgeMs = juce::Time::getCurrentTime().toMilliseconds() - createdAtMs;
    if (createdAtMs <= 0 || requestAgeMs < 0 || requestAgeMs > kTone3000LoopbackTimeoutMs)
    {
        getTone3000PendingAuthFile().deleteFile();
        return makeTone3000Error("The pending TONE3000 sign-in expired. Start the connection again.");
    }

    const auto expectedState = pendingObject->getProperty("state").toString();
    if (stateFromCallback.isEmpty())
        return makeTone3000Error("OAuth callback did not include the required state");
    if (expectedState != stateFromCallback)
        return makeTone3000Error("OAuth state mismatch");

    const auto clientId = clientIdOverride.trim().isNotEmpty()
        ? clientIdOverride.trim()
        : pendingObject->getProperty("clientId").toString();
    const auto redirectUri = redirectUriOverride.trim().isNotEmpty()
        ? redirectUriOverride.trim()
        : pendingObject->getProperty("redirectUri").toString();
    const auto verifier = pendingObject->getProperty("codeVerifier").toString();

    juce::StringPairArray fields;
    fields.set("grant_type", "authorization_code");
    fields.set("code", code.trim());
    fields.set("code_verifier", verifier);
    fields.set("redirect_uri", redirectUri);
    fields.set("client_id", clientId);

    auto tokenPayload = postTone3000OAuthToken(fields);
    if (auto* tokenObject = tokenPayload.getDynamicObject())
    {
        if (static_cast<bool>(tokenObject->getProperty("success")) == false && tokenObject->hasProperty("error"))
            return tokenPayload;
    }

    auto result = storeTone3000TokenPayload(tokenPayload, clientId);
    if (auto* resultObject = result.getDynamicObject())
    {
        if (static_cast<bool>(resultObject->getProperty("success")))
            getTone3000PendingAuthFile().deleteFile();
    }
    return result;
}

juce::var waitForTone3000LoopbackCallback(juce::StreamingSocket& listener,
                                          int generation,
                                          int timeoutMs)
{
    const auto deadline = juce::Time::currentTimeMillis() + timeoutMs;

    while (juce::Time::currentTimeMillis() < deadline)
    {
        if (generation != tone3000AuthFlowGeneration.load())
        {
            getTone3000PendingAuthFile().deleteFile();
            return makeTone3000AuthFlowResult("canceled", false, "TONE3000 sign-in was canceled.");
        }

        const auto ready = listener.waitUntilReady(true, 250);
        if (ready < 0)
            return makeTone3000AuthFlowResult("failed", false, "TONE3000 callback listener stopped unexpectedly.", {}, {}, true);
        if (ready == 0)
            continue;

        std::unique_ptr<juce::StreamingSocket> client(listener.waitForNextConnection());
        if (client == nullptr)
            continue;

        const auto request = readTone3000HttpRequest(*client, 3000);
        const auto firstLine = request.upToFirstOccurrenceOf("\n", false, false).trim();
        if (! firstLine.startsWith("GET "))
        {
            writeTone3000CallbackPage(*client, "OpenStudio TONE3000", "This callback only accepts a browser GET request.", false);
            continue;
        }

        const auto target = firstLine.fromFirstOccurrenceOf(" ", false, false)
                                     .upToFirstOccurrenceOf(" ", false, false)
                                     .trim();
        const auto path = target.upToFirstOccurrenceOf("?", false, false);
        if (path != kTone3000LoopbackPath)
        {
            writeTone3000CallbackPage(*client, "OpenStudio TONE3000", "This callback path is not used by OpenStudio.", false);
            continue;
        }

        const auto query = target.fromFirstOccurrenceOf("?", false, false);
        const auto params = parseTone3000QueryString(query);
        const auto error = params["error"];
        const auto canceled = params["canceled"];
        const auto toneId = params["tone_id"];
        const auto code = params["code"];
        const auto state = params["state"];

        if (error.equalsIgnoreCase("access_denied")
            || (canceled.equalsIgnoreCase("true") && code.isEmpty()))
        {
            getTone3000PendingAuthFile().deleteFile();
            writeTone3000CallbackPage(*client, "TONE3000 sign-in canceled", "You can return to OpenStudio and connect again when you are ready.", false);
            return makeTone3000AuthFlowResult("canceled", false, error.isNotEmpty() ? error : juce::String("TONE3000 sign-in was canceled."), {}, toneId);
        }

        if (error.isNotEmpty())
        {
            getTone3000PendingAuthFile().deleteFile();
            writeTone3000CallbackPage(*client, "TONE3000 sign-in failed", "OpenStudio received an authorization error. Return to the app and try again.", false);
            return makeTone3000AuthFlowResult("failed", false, error, {}, toneId);
        }

        if (code.isEmpty())
        {
            writeTone3000CallbackPage(*client, "TONE3000 sign-in failed", "OpenStudio did not receive an OAuth code from TONE3000.", false);
            return makeTone3000AuthFlowResult("failed", false, "OAuth callback did not include a code.", {}, toneId);
        }
        if (state.isEmpty())
        {
            getTone3000PendingAuthFile().deleteFile();
            writeTone3000CallbackPage(*client, "TONE3000 sign-in failed", "OpenStudio did not receive the OAuth security state from TONE3000.", false);
            return makeTone3000AuthFlowResult("failed", false, "OAuth callback did not include the required state.", {}, toneId);
        }

        auto exchangeResult = exchangeTone3000OAuthCode(code, state, {}, {});
        if (auto* exchangeObject = exchangeResult.getDynamicObject())
        {
            if (static_cast<bool> (exchangeObject->getProperty("success")))
            {
                exchangeObject->setProperty("status", "connected");
                if (toneId.isNotEmpty())
                    exchangeObject->setProperty("toneId", toneId);
                writeTone3000CallbackPage(*client, "Connected to OpenStudio", "You can return to OpenStudio. TONE3000 is connected for this user account.", true);
                return exchangeResult;
            }

            writeTone3000CallbackPage(*client, "TONE3000 sign-in failed", "OpenStudio could not complete the token exchange. Return to the app and try again.", false);
            exchangeObject->setProperty("status", "failed");
            return exchangeResult;
        }

        writeTone3000CallbackPage(*client, "TONE3000 sign-in failed", "OpenStudio could not read the token exchange result.", false);
        return makeTone3000AuthFlowResult("failed", false, "Token exchange returned an invalid result.", {}, toneId);
    }

    getTone3000PendingAuthFile().deleteFile();
    return makeTone3000AuthFlowResult("failed", false, "Timed out waiting for TONE3000 to return to OpenStudio.", {}, {}, true);
}

juce::var startTone3000AuthFlow(juce::var optionsPayload)
{
    if (optionsPayload.isString())
        optionsPayload = juce::JSON::parse(optionsPayload.toString());

    auto* options = optionsPayload.getDynamicObject();
    auto clientId = getTone3000OptionString(options, "clientId", getConfiguredTone3000ClientId());
    const auto redirectUri = getTone3000OptionString(options, "redirectUri", kTone3000DefaultRedirectUri);
    const auto prompt = getTone3000OptionString(options, "prompt");
    const auto toneId = getTone3000OptionString(options, "toneId");
    const auto loginHint = getTone3000OptionString(options, "loginHint");
    const auto timeoutMs = juce::jlimit(30000, kTone3000LoopbackTimeoutMs, getTone3000OptionInt(options, "timeoutMs", kTone3000LoopbackTimeoutMs));

    if (clientId.isEmpty())
    {
        return makeTone3000AuthFlowResult("failed",
                                          false,
                                          "OpenStudio was not built with a TONE3000 publishable client_id. Use Advanced / Developer with a registered test client_id.",
                                          {},
                                          {},
                                          true);
    }

    if (tone3000AuthFlowActive.exchange(true))
        return makeTone3000AuthFlowResult("failed", false, "A TONE3000 sign-in is already in progress.");

    struct ActiveFlag
    {
        ~ActiveFlag() { tone3000AuthFlowActive.store(false); }
    } activeFlag;

    const auto generation = tone3000AuthFlowGeneration.fetch_add(1) + 1;

    juce::StreamingSocket listener;
    if (! listener.createListener(kTone3000LoopbackPort, kTone3000LoopbackHost))
    {
        auto fallbackRequest = createTone3000AuthRequest(clientId, redirectUri, prompt, toneId, loginHint);
        juce::String authUrl;
        if (auto* fallbackObject = fallbackRequest.getDynamicObject())
            authUrl = fallbackObject->getProperty("authUrl").toString();

        return makeTone3000AuthFlowResult("failed",
                                          false,
                                          "Could not open the local TONE3000 callback listener on 127.0.0.1:18762. Use Advanced / Developer fallback.",
                                          authUrl,
                                          {},
                                          true);
    }

    auto authRequest = createTone3000AuthRequest(clientId, redirectUri, prompt, toneId, loginHint);
    auto* requestObject = authRequest.getDynamicObject();
    if (requestObject == nullptr || ! static_cast<bool> (requestObject->getProperty("success")))
    {
        const auto error = requestObject != nullptr ? requestObject->getProperty("error").toString() : juce::String("Could not create TONE3000 auth request.");
        return makeTone3000AuthFlowResult("failed", false, error, {}, {}, true);
    }

    const auto authUrl = requestObject->getProperty("authUrl").toString();
    if (authUrl.isEmpty())
        return makeTone3000AuthFlowResult("failed", false, "TONE3000 did not produce an authorization URL.", {}, {}, true);

    if (! juce::URL(authUrl).launchInDefaultBrowser())
        return makeTone3000AuthFlowResult("failed", false, "Could not open the TONE3000 sign-in page in the default browser.", authUrl, {}, true);

    auto result = waitForTone3000LoopbackCallback(listener, generation, timeoutMs);
    if (auto* resultObject = result.getDynamicObject())
    {
        if (! resultObject->hasProperty("authUrl"))
            resultObject->setProperty("authUrl", authUrl);
        if (! resultObject->hasProperty("clientId"))
            resultObject->setProperty("clientId", clientId);
    }
    return result;
}

juce::var cancelTone3000AuthFlow()
{
    tone3000AuthFlowGeneration.fetch_add(1);
    getTone3000PendingAuthFile().deleteFile();

    juce::StreamingSocket wakeSocket;
    wakeSocket.connect(kTone3000LoopbackHost, kTone3000LoopbackPort, 500);

    return makeTone3000AuthFlowResult("canceled", true);
}

juce::var refreshTone3000Auth(const juce::String& clientIdOverride)
{
    juce::String error;
    auto stored = loadProtectedJson(getTone3000TokenFile(), error);
    auto* object = stored.getDynamicObject();
    if (object == nullptr)
        return makeTone3000Error(error.isNotEmpty() ? error : "No stored TONE3000 token");

    const auto refreshToken = object->getProperty("refreshToken").toString();
    const auto clientId = clientIdOverride.trim().isNotEmpty()
        ? clientIdOverride.trim()
        : object->getProperty("clientId").toString();
    if (refreshToken.isEmpty())
        return makeTone3000Error("No stored TONE3000 refresh token");
    if (clientId.isEmpty())
        return makeTone3000Error("Missing TONE3000 client_id");

    juce::StringPairArray fields;
    fields.set("grant_type", "refresh_token");
    fields.set("refresh_token", refreshToken);
    fields.set("client_id", clientId);

    auto tokenPayload = postTone3000OAuthToken(fields);
    if (auto* tokenObject = tokenPayload.getDynamicObject())
    {
        if (static_cast<bool>(tokenObject->getProperty("success")) == false && tokenObject->hasProperty("error"))
        {
            if (tokenObject->getProperty("oauthError").toString() == "invalid_grant")
            {
                getTone3000TokenFile().deleteFile();
                getTone3000PendingAuthFile().deleteFile();
                auto expired = makeTone3000Error("TONE3000 session expired. Connect again.", static_cast<int> (tokenObject->getProperty("statusCode")));
                if (auto* expiredObject = expired.getDynamicObject())
                {
                    expiredObject->setProperty("oauthError", "invalid_grant");
                    expiredObject->setProperty("authenticated", false);
                }
                return expired;
            }
            return tokenPayload;
        }
        if (!tokenObject->hasProperty("refresh_token") || tokenObject->getProperty("refresh_token").toString().isEmpty())
            tokenObject->setProperty("refresh_token", refreshToken);
    }

    return storeTone3000TokenPayload(tokenPayload, clientId);
}

juce::String sanitizeNAMFileName(juce::String name)
{
    name = name.trim();
    if (name.isEmpty())
        name = "nam-model";

    juce::String safe;
    for (int i = 0; i < name.length(); ++i)
    {
        const auto c = name[i];
        const bool ok = juce::CharacterFunctions::isLetterOrDigit(c) || c == '-' || c == '_' || c == '.';
        safe << (ok ? juce::String::charToString(c) : "-");
    }
    while (safe.contains("--"))
        safe = safe.replace("--", "-");
    return safe.trimCharactersAtStart("-").trimCharactersAtEnd("-").substring(0, 96);
}

bool isTone3000AudioIRExtension(const juce::String& extension)
{
    const auto ext = extension.toLowerCase();
    return ext == ".wav" || ext == ".wave" || ext == ".aif" || ext == ".aiff" || ext == ".flac";
}

juce::String getTone3000DownloadExtension(const juce::String& modelUrl)
{
    const auto withoutQuery = modelUrl.upToFirstOccurrenceOf("?", false, false);
    const auto withoutFragment = withoutQuery.upToFirstOccurrenceOf("#", false, false);
    return juce::File(juce::URL::removeEscapeChars(withoutFragment)).getFileExtension().toLowerCase();
}

juce::var parseJsonFileOrDefault(const juce::File& file, const juce::String& arrayProperty)
{
    if (file.existsAsFile())
    {
        auto parsed = juce::JSON::parse(file);
        if (!parsed.isVoid())
            return parsed;
    }

    juce::DynamicObject::Ptr root = new juce::DynamicObject();
    root->setProperty("schemaVersion", 1);
    root->setProperty(arrayProperty, juce::Array<juce::var>());
    return juce::var(root.get());
}

juce::String normaliseNAMCatalogUpdaterArchitecture(juce::String architecture)
{
    architecture = architecture.trim().toLowerCase();
    if (architecture == "a1")
        return "1";
    if (architecture == "a2")
        return "2";
    if (architecture == "1" || architecture == "2" || architecture == "custom")
        return architecture;
    return {};
}

juce::var refreshNAMCatalogFromUpdater(juce::var optionsVar)
{
    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", false);

    const auto script = findOpenStudioNAMCatalogUpdaterScript();
    if (! script.existsAsFile())
    {
        result->setProperty("error", "NAM catalog updater script not found.");
        return juce::var(result.get());
    }

    const auto python = findOpenStudioPythonForNAMCatalog();
    const auto namRoot = getOpenStudioNAMRoot();
    const auto dbFile = getOpenStudioNAMCatalogSqlite();
    const auto jsonFile = getOpenStudioNAMCatalogJson();

    auto* options = optionsVar.getDynamicObject();
    auto optionProperty = [] (juce::DynamicObject* object,
                              const juce::String& primary,
                              const juce::String& fallback,
                              juce::var defaultValue)
    {
        if (object == nullptr)
            return defaultValue;

        auto value = object->getProperty(primary);
        if (value.isVoid() && fallback.isNotEmpty())
            value = object->getProperty(fallback);

        return value.isVoid() ? defaultValue : value;
    };

    const int pageSize = juce::jlimit(1, 25, static_cast<int>(optionProperty(options, "page_size", "pageSize", 25)));
    const int pages = juce::jlimit(1, 3, static_cast<int>(optionProperty(options, "pages", {}, 1)));
    const int maxModelFetches = juce::jlimit(0, 200, static_cast<int>(optionProperty(options, "max_model_fetches", "maxModelFetches", 60)));
    const double minInterval = juce::jlimit(0.25, 5.0, static_cast<double>(optionProperty(options, "min_interval", "minInterval", 0.75)));
    const auto gears = optionProperty(options, "gears", {}, "amp_amp-cab").toString().trim();
    const auto query = optionProperty(options, "query", {}, "").toString();
    const auto architecture = normaliseNAMCatalogUpdaterArchitecture(optionProperty(options, "architecture", {}, "").toString());

    juce::StringArray args;
    args.add(python);
    args.add(script.getFullPathName());
    args.add("--nam-root");
    args.add(namRoot.getFullPathName());
    args.add("--db");
    args.add(dbFile.getFullPathName());
    args.add("--json");
    args.add(jsonFile.getFullPathName());
    args.add("--page-size");
    args.add(juce::String(pageSize));
    args.add("--pages");
    args.add(juce::String(pages));
    args.add("--max-model-fetches");
    args.add(juce::String(maxModelFetches));
    args.add("--min-interval");
    args.add(juce::String(minInterval, 2));
    args.add("--gears");
    args.add(gears.isNotEmpty() ? gears : juce::String("amp_amp-cab"));

    if (query.isNotEmpty())
    {
        args.add("--query");
        args.add(query);
    }

    if (architecture.isNotEmpty())
    {
        args.add("--architecture");
        args.add(architecture);
    }

    const auto startMs = juce::Time::getMillisecondCounterHiRes();
    juce::ChildProcess process;
    const bool started = process.start(args);
    if (! started)
    {
        result->setProperty("error", "Could not start Python for NAM catalog refresh.");
        result->setProperty("pythonPath", python);
        result->setProperty("scriptPath", script.getFullPathName());
        return juce::var(result.get());
    }

    bool timedOut = false;
    if (! process.waitForProcessToFinish(180000))
    {
        timedOut = true;
        process.kill();
    }

    const int exitCode = timedOut ? -1 : process.getExitCode();
    const auto output = process.readAllProcessOutput().trim();
    const double durationMs = juce::Time::getMillisecondCounterHiRes() - startMs;
    const bool success = ! timedOut && exitCode == 0 && jsonFile.existsAsFile();

    result->setProperty("success", success);
    result->setProperty("exitCode", exitCode);
    result->setProperty("timedOut", timedOut);
    result->setProperty("durationMs", durationMs);
    result->setProperty("pythonPath", python);
    result->setProperty("scriptPath", script.getFullPathName());
    result->setProperty("rootPath", namRoot.getFullPathName());
    result->setProperty("catalogPath", dbFile.getFullPathName());
    result->setProperty("catalogJsonPath", jsonFile.getFullPathName());
    result->setProperty("output", output.substring(0, 4000));
    result->setProperty("pageSize", pageSize);
    result->setProperty("pages", pages);
    result->setProperty("maxModelFetches", maxModelFetches);

    auto catalog = parseJsonFileOrDefault(jsonFile, "tones");
    if (auto* catalogObject = catalog.getDynamicObject())
    {
        const auto tonesVar = catalogObject->getProperty("tones");
        const int rowCount = tonesVar.isArray() ? tonesVar.getArray()->size() : 0;
        result->setProperty("toneRows", rowCount);
        result->setProperty("generatedAt", catalogObject->getProperty("generatedAt"));
    }
    result->setProperty("catalog", catalog);

    if (! success)
    {
        if (timedOut)
            result->setProperty("error", "NAM catalog refresh timed out.");
        else if (exitCode != 0)
            result->setProperty("error", "NAM catalog refresh failed with exit code " + juce::String(exitCode) + ".");
        else
            result->setProperty("error", "NAM catalog refresh did not create catalog.json.");
    }

    return juce::var(result.get());
}

juce::String getModelObjectString(juce::DynamicObject* model, const juce::String& primary, const juce::String& fallback)
{
    if (model == nullptr)
        return {};
    auto value = model->getProperty(primary).toString();
    if (value.isEmpty() && fallback.isNotEmpty())
        value = model->getProperty(fallback).toString();
    return value;
}

juce::String normaliseNAMSha256(juce::String checksum)
{
    checksum = checksum.trim().toLowerCase();
    if (checksum.startsWith("sha256:") || checksum.startsWith("sha256="))
        checksum = checksum.substring(7).trim();
    return checksum;
}

bool calculateNAMAssetSha256(const juce::File& file,
                             juce::String& actualSha256,
                             juce::String& error)
{
    if (! file.existsAsFile())
    {
        error = "The NAM or IR asset could not be found.";
        return false;
    }

    juce::FileInputStream input(file);
    if (! input.openedOk())
    {
        error = "OpenStudio could not read the NAM or IR asset.";
        return false;
    }

    actualSha256 = juce::SHA256(input).toHexString().toLowerCase();
    return true;
}

juce::var inspectNAMAssetFile(const juce::String& filePath)
{
    struct CachedInspection
    {
        juce::String path;
        juce::int64 fileSize = 0;
        juce::int64 modificationTimeMs = 0;
        juce::String checksum;
    };
    static juce::CriticalSection cacheLock;
    static std::vector<CachedInspection> cache;

    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    const juce::File file(filePath);
    result->setProperty("success", false);
    result->setProperty("exists", file.existsAsFile());
    result->setProperty("path", file.getFullPathName());
    result->setProperty("fileName", file.getFileName());
    result->setProperty("extension", file.getFileExtension().toLowerCase());

    const auto canonicalPath = file.getFullPathName();
    const auto fileSize = file.getSize();
    const auto modificationTimeMs =
        file.getLastModificationTime().toMilliseconds();
    juce::String checksum;
    {
        const juce::ScopedLock lock(cacheLock);
        for (const auto& entry : cache)
        {
            if (entry.path == canonicalPath
                && entry.fileSize == fileSize
                && entry.modificationTimeMs
                       == modificationTimeMs)
            {
                checksum = entry.checksum;
                break;
            }
        }
    }

    juce::String error;
    if (checksum.isEmpty()
        && ! calculateNAMAssetSha256(file, checksum, error))
    {
        result->setProperty("error", error);
        return juce::var(result.get());
    }
    if (checksum.isNotEmpty())
    {
        const juce::ScopedLock lock(cacheLock);
        auto existing = std::find_if(
            cache.begin(),
            cache.end(),
            [&canonicalPath] (const CachedInspection& entry)
            {
                return entry.path == canonicalPath;
            });
        const CachedInspection newEntry {
            canonicalPath,
            fileSize,
            modificationTimeMs,
            checksum
        };
        if (existing != cache.end())
            *existing = newEntry;
        else
            cache.push_back(newEntry);
        constexpr size_t maximumCachedAssets = 512;
        if (cache.size() > maximumCachedAssets)
            cache.erase(cache.begin());
    }

    result->setProperty("success", true);
    result->setProperty("checksum", checksum);
    result->setProperty("assetId", "sha256:" + checksum);
    result->setProperty("fileSizeBytes", static_cast<double>(fileSize));
    return juce::var(result.get());
}

bool isAllowedNAMRelinkCandidate(const juce::File& file, const juce::String& slot)
{
    const auto extension = file.getFileExtension().toLowerCase();
    if (slot == "cab")
        return extension == ".wav" || extension == ".aif" || extension == ".aiff"
            || extension == ".flac" || extension == ".ogg";

    return extension == ".nam";
}

juce::var findNAMAssetInDirectory(const juce::String& directoryPath,
                                  const juce::String& expectedFileName,
                                  const juce::String& expectedChecksum,
                                  juce::int64 expectedSize,
                                  const juce::String& slot)
{
    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", false);
    const juce::File directory(directoryPath);
    if (! directory.isDirectory())
    {
        result->setProperty("error", "The selected search folder is not available.");
        return juce::var(result.get());
    }

    const auto checksum = normaliseNAMSha256(expectedChecksum);
    const bool checksumSupplied = checksum.isNotEmpty();
    if (checksumSupplied && (checksum.length() != 64 || ! checksum.containsOnly("0123456789abcdef")))
    {
        result->setProperty("error", "The project contains an invalid NAM asset checksum.");
        return juce::var(result.get());
    }

    constexpr int maxCandidateFiles = 10000;
    juce::Array<juce::File> candidates;
    bool truncated = false;
    for (const auto& entry : juce::RangedDirectoryIterator(
             directory, true, "*", juce::File::findFiles))
    {
        const auto file = entry.getFile();
        if (! isAllowedNAMRelinkCandidate(file, slot))
            continue;
        if (candidates.size() >= maxCandidateFiles)
        {
            truncated = true;
            break;
        }
        candidates.add(file);
    }

    result->setProperty("checkedFiles", candidates.size());
    result->setProperty("truncated", truncated);

    if (checksumSupplied)
    {
        // Same-sized and same-named files are checked first, but the checksum is
        // authoritative and still permits users to rename or move the asset.
        for (int pass = 0; pass < 3; ++pass)
        {
            for (const auto& candidate : candidates)
            {
                const bool sameName = candidate.getFileName().equalsIgnoreCase(expectedFileName);
                const bool sameSize = expectedSize <= 0 || candidate.getSize() == expectedSize;
                if ((pass == 0 && (!sameName || !sameSize))
                    || (pass == 1 && (sameName || !sameSize))
                    || (pass == 2 && sameSize))
                {
                    continue;
                }

                juce::String actualChecksum;
                juce::String hashError;
                if (calculateNAMAssetSha256(candidate, actualChecksum, hashError)
                    && actualChecksum == checksum)
                {
                    result->setProperty("success", true);
                    result->setProperty("foundPath", candidate.getFullPathName());
                    result->setProperty("matchReason", "checksum");
                    return juce::var(result.get());
                }
            }
        }

        result->setProperty("error", truncated
            ? "No checksum match was found before the search limit was reached. Choose a narrower folder."
            : "No file with the project asset checksum was found in this folder.");
        return juce::var(result.get());
    }

    juce::Array<juce::File> filenameMatches;
    for (const auto& candidate : candidates)
    {
        if (candidate.getFileName().equalsIgnoreCase(expectedFileName)
            && (expectedSize <= 0 || candidate.getSize() == expectedSize))
        {
            filenameMatches.add(candidate);
        }
    }

    if (filenameMatches.size() == 1)
    {
        result->setProperty("success", true);
        result->setProperty("foundPath", filenameMatches.getFirst().getFullPathName());
        result->setProperty("matchReason", expectedSize > 0 ? "filename-and-size" : "filename");
        return juce::var(result.get());
    }

    result->setProperty("ambiguous", filenameMatches.size() > 1);
    result->setProperty("error", filenameMatches.size() > 1
        ? "More than one unverified filename match was found. Locate the exact file manually."
        : "No matching asset filename was found in this folder.");
    return juce::var(result.get());
}

bool verifyNAMFileSha256(const juce::File& file,
                         const juce::String& expectedSha256,
                         juce::String& actualSha256,
                         juce::String& error)
{
    const auto normalizedExpected = normaliseNAMSha256(expectedSha256);
    if (expectedSha256.trim().isNotEmpty()
        && (normalizedExpected.length() != 64
            || ! normalizedExpected.containsOnly("0123456789abcdef")))
    {
        error = "The NAM catalog supplied an invalid SHA-256 checksum.";
        return false;
    }

    if (! calculateNAMAssetSha256(file, actualSha256, error))
        return false;
    if (normalizedExpected.isEmpty() || actualSha256 == normalizedExpected)
        return true;

    error = "The downloaded NAM file failed SHA-256 verification.";
    return false;
}

bool isTrustedTone3000DownloadHost(juce::String domain)
{
    domain = domain.trim().toLowerCase();
    return domain == "tone3000.com"
        || domain == "www.tone3000.com"
        || domain.endsWith(".tone3000.com");
}

bool isSecureNAMDownloadURL(const juce::URL& url)
{
    return url.getScheme().equalsIgnoreCase("https") && url.getDomain().isNotEmpty();
}

bool isAllowedExternalBrowserURL(juce::String rawURL)
{
    rawURL = rawURL.trim();
    if (rawURL.isEmpty()
        || rawURL.containsAnyOf("\r\n\t")
        || (! rawURL.startsWithIgnoreCase("https://")
            && ! rawURL.startsWithIgnoreCase("http://")))
    {
        return false;
    }

    const juce::URL url(rawURL);
    const auto scheme = url.getScheme();
    return (scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("http"))
        && url.getDomain().isNotEmpty();
}

juce::URL resolveNAMDownloadRedirect(const juce::URL& currentURL, juce::String location)
{
    location = location.trim();
    if (location.startsWithIgnoreCase("https://") || location.startsWithIgnoreCase("http://"))
        return juce::URL(location);

    if (location.startsWith("//"))
        return juce::URL("https:" + location);

    if (location.startsWithChar('/'))
        return juce::URL(currentURL.getOrigin() + location);

    return currentURL.getParentURL().getChildURL(location);
}

struct NAMDownloadStream
{
    std::unique_ptr<juce::InputStream> input;
    int statusCode = 0;
    juce::String error;
};

NAMDownloadStream openAuthenticatedNAMDownload(const juce::String& modelURL,
                                                const juce::String& accessToken)
{
    NAMDownloadStream result;
    if (accessToken.containsAnyOf("\r\n"))
    {
        result.error = "The TONE3000 access token contains invalid header characters";
        return result;
    }

    auto currentURL = juce::URL(modelURL);
    if (! isSecureNAMDownloadURL(currentURL)
        || ! isTrustedTone3000DownloadHost(currentURL.getDomain()))
    {
        result.error = "TONE3000 model_url must use HTTPS on an official tone3000.com host";
        return result;
    }

    constexpr int maxRedirects = 5;
    for (int redirectCount = 0; redirectCount <= maxRedirects; ++redirectCount)
    {
        const bool trustedDestination = isTrustedTone3000DownloadHost(currentURL.getDomain());
        juce::String headers;
        if (trustedDestination && accessToken.isNotEmpty())
            headers << "Authorization: Bearer " << accessToken << "\r\n";

        juce::StringPairArray responseHeaders;
        result.statusCode = 0;
        auto input = currentURL.createInputStream(
            juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
                .withExtraHeaders(headers)
                .withConnectionTimeoutMs(30000)
                .withResponseHeaders(&responseHeaders)
                .withNumRedirectsToFollow(0)
                .withStatusCode(&result.statusCode));

        if (result.statusCode < 300 || result.statusCode >= 400)
        {
            result.input = std::move(input);
            return result;
        }

        if (redirectCount == maxRedirects)
        {
            result.error = "TONE3000 model download exceeded the redirect limit";
            return result;
        }

        const auto location = responseHeaders.getValue("Location", {}).trim();
        if (location.isEmpty())
        {
            result.error = "TONE3000 model download returned a redirect without a Location header";
            return result;
        }

        auto redirectURL = resolveNAMDownloadRedirect(currentURL, location);
        if (! isSecureNAMDownloadURL(redirectURL))
        {
            result.error = "TONE3000 model download refused an insecure redirect";
            return result;
        }

        // A CDN redirect is allowed, but this loop creates a fresh request and
        // only sends the Bearer token when the destination is still TONE3000.
        input.reset();
        currentURL = std::move(redirectURL);
    }

    result.error = "TONE3000 model download could not be opened";
    return result;
}

int getModelObjectInt(juce::DynamicObject* model, const juce::String& primary, const juce::String& fallback)
{
    if (model == nullptr)
        return 0;
    auto value = model->getProperty(primary);
    if (value.isVoid() && fallback.isNotEmpty())
        value = model->getProperty(fallback);
    return static_cast<int>(value);
}

juce::var makeNAMLibraryInfo()
{
    juce::DynamicObject::Ptr root = new juce::DynamicObject();
    const auto namRoot = getOpenStudioNAMRoot();
    root->setProperty("rootPath", namRoot.getFullPathName());
    root->setProperty("libraryPath", namRoot.getChildFile("library").getFullPathName());
    root->setProperty("catalogPath", namRoot.getChildFile("catalog.sqlite").getFullPathName());
    root->setProperty("catalogJsonPath", getOpenStudioNAMCatalogJson().getFullPathName());
    root->setProperty("manifestPath", getOpenStudioNAMManifestJson().getFullPathName());
    return juce::var(root.get());
}

bool namLibraryRecordMatches(juce::DynamicObject* record, int modelId, const juce::String& localPath)
{
    if (record == nullptr)
        return false;

    if (modelId > 0 && static_cast<int>(record->getProperty("modelId")) == modelId)
        return true;

    return localPath.isNotEmpty() && record->getProperty("localPath").toString() == localPath;
}

juce::String normaliseNAMArchitectureForCompare(juce::String architecture)
{
    architecture = architecture.trim().toLowerCase();
    if (architecture == "a1")
        return "1";
    if (architecture == "a2")
        return "2";
    if (architecture == "1" || architecture == "2" || architecture == "custom")
        return architecture;
    return architecture;
}

bool nonEmptyNAMMetadataChanged(const juce::String& latestValue, const juce::String& currentValue)
{
    return latestValue.trim().isNotEmpty() && latestValue.trim() != currentValue.trim();
}

struct NAMCatalogMatch
{
    juce::var model;
    juce::var tone;
    bool exactModelId = false;
};

NAMCatalogMatch findCatalogModelForInstalledNAMRecord(const juce::var& catalog, juce::DynamicObject* record)
{
    NAMCatalogMatch match;
    if (record == nullptr)
        return match;

    auto* catalogObject = catalog.getDynamicObject();
    if (catalogObject == nullptr)
        return match;

    const int installedModelId = static_cast<int>(record->getProperty("modelId"));
    const int installedToneId = static_cast<int>(record->getProperty("toneId"));
    const auto installedArchitecture = normaliseNAMArchitectureForCompare(record->getProperty("architecture").toString());
    const auto tonesVar = catalogObject->getProperty("tones");
    auto* tones = tonesVar.getArray();
    if (tones == nullptr)
        return match;

    for (auto& toneVar : *tones)
    {
        auto* tone = toneVar.getDynamicObject();
        if (tone == nullptr)
            continue;

        const int toneId = getModelObjectInt(tone, "id", "toneId");
        const auto modelsVar = tone->getProperty("models");
        auto* models = modelsVar.getArray();
        if (models == nullptr)
            continue;

        for (auto& modelVar : *models)
        {
            auto* model = modelVar.getDynamicObject();
            if (model == nullptr)
                continue;

            const int modelId = getModelObjectInt(model, "id", "model_id");
            if (installedModelId > 0 && modelId == installedModelId)
            {
                match.model = modelVar;
                match.tone = toneVar;
                match.exactModelId = true;
                return match;
            }

            if (match.model.isVoid()
                && installedToneId > 0
                && toneId == installedToneId)
            {
                const auto modelArchitecture = normaliseNAMArchitectureForCompare(getModelObjectString(model, "architecture_version", "architecture"));
                if (installedArchitecture.isEmpty() || modelArchitecture.isEmpty() || installedArchitecture == modelArchitecture)
                {
                    match.model = modelVar;
                    match.tone = toneVar;
                    match.exactModelId = false;
                }
            }
        }
    }

    return match;
}

juce::String getNAMCatalogUpdateReason(juce::DynamicObject* record, juce::DynamicObject* latestModel, bool exactModelId)
{
    if (record == nullptr || latestModel == nullptr)
        return {};

    if (! exactModelId)
    {
        const int latestModelId = getModelObjectInt(latestModel, "id", "model_id");
        const int currentModelId = static_cast<int>(record->getProperty("modelId"));
        if (latestModelId > 0 && latestModelId != currentModelId)
            return "New catalog model for this tone";
    }

    const auto latestModelUrl = getModelObjectString(latestModel, "model_url", "modelUrl");
    const auto currentModelUrl = record->getProperty("modelUrl").toString();
    if (nonEmptyNAMMetadataChanged(latestModelUrl, currentModelUrl))
        return "Download URL changed";

    const auto latestChecksum = normaliseNAMSha256(getModelObjectString(latestModel, "sha256", "checksum"));
    const auto currentChecksum = normaliseNAMSha256(record->getProperty("checksum").toString());
    if (nonEmptyNAMMetadataChanged(latestChecksum, currentChecksum))
        return "Checksum changed";

    const auto latestName = getModelObjectString(latestModel, "name", "title");
    const auto currentName = record->getProperty("name").toString();
    if (nonEmptyNAMMetadataChanged(latestName, currentName))
        return "Name changed";

    const auto latestArchitecture = normaliseNAMArchitectureForCompare(getModelObjectString(latestModel, "architecture_version", "architecture"));
    const auto currentArchitecture = normaliseNAMArchitectureForCompare(record->getProperty("architecture").toString());
    if (latestArchitecture.isNotEmpty() && latestArchitecture != currentArchitecture)
        return "Architecture changed";

    return {};
}

bool setNAMRecordPropertyIfChanged(juce::DynamicObject& object, const juce::Identifier& property, const juce::var& value)
{
    if (object.getProperty(property) == value)
        return false;

    object.setProperty(property, value);
    return true;
}

bool setNAMRecordObjectPropertyIfChanged(juce::DynamicObject& object, const juce::Identifier& property, const juce::var& value)
{
    if (juce::JSON::toString(object.getProperty(property), false) == juce::JSON::toString(value, false))
        return false;

    object.setProperty(property, value);
    return true;
}

bool isFileInsideNAMPreviews(const juce::File& file)
{
    auto previewPath = getOpenStudioNAMRoot().getChildFile("previews").getFullPathName();
    if (!previewPath.endsWithChar(juce::File::getSeparatorChar()))
        previewPath << juce::File::getSeparatorString();

    return file.getFullPathName().startsWithIgnoreCase(previewPath);
}

bool areNAMPathsEquivalent(const juce::String& leftPath, const juce::String& rightPath)
{
    if (leftPath.isEmpty() || rightPath.isEmpty())
        return false;

    auto normalise = [] (const juce::String& path)
    {
        auto normalised = juce::File(path).getFullPathName().replaceCharacter('\\', '/');
        while (normalised.length() > 1 && normalised.endsWithChar('/'))
            normalised = normalised.dropLastCharacters(1);
#if JUCE_WINDOWS
        return normalised.toLowerCase();
#else
        return normalised;
#endif
    };

    return normalise(leftPath) == normalise(rightPath);
}

juce::var makeNAMPreviewRetentionResult(const juce::String& warning,
                                        const juce::String& loadedSlot = {})
{
    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", true);
    result->setProperty("deleteSkipped", true);
    result->setProperty("retained", true);
    result->setProperty("recoverable", true);
    result->setProperty("warning", warning);
    if (loadedSlot.isNotEmpty())
    {
        result->setProperty("inUse", true);
        result->setProperty("loadedSlot", loadedSlot);
    }
    return juce::var(result.get());
}

juce::var refreshNAMLibraryManifest(bool persistIfChanged)
{
    const juce::ScopedLock manifestLock(namLibraryMutationLock);
    auto manifest = parseJsonFileOrDefault(getOpenStudioNAMManifestJson(), "installed");
    auto* manifestObject = manifest.getDynamicObject();
    if (manifestObject == nullptr)
        return manifest;

    const auto nowIso = juce::Time::getCurrentTime().toISO8601(true);
    const auto catalog = parseJsonFileOrDefault(getOpenStudioNAMCatalogJson(), "tones");
    const auto catalogGeneratedAt = catalog.getDynamicObject() != nullptr
        ? catalog.getDynamicObject()->getProperty("generatedAt").toString()
        : juce::String();
    bool changed = false;
    const auto installedVar = manifestObject->getProperty("installed");
    if (auto* installed = installedVar.getArray())
    {
        for (auto& recordVar : *installed)
        {
            if (auto* record = recordVar.getDynamicObject())
            {
                bool recordChanged = false;
                const auto localPath = record->getProperty("localPath").toString();
                const juce::File localFile(localPath);
                const bool missing = localPath.isEmpty() || !localFile.existsAsFile();
                recordChanged = setNAMRecordPropertyIfChanged(*record, "missing", missing) || recordChanged;
                recordChanged = setNAMRecordPropertyIfChanged(*record, "fileSizeBytes", missing ? juce::var() : juce::var(static_cast<double>(localFile.getSize()))) || recordChanged;
                recordChanged = setNAMRecordPropertyIfChanged(*record, "missingSince", missing
                    ? (record->getProperty("missingSince").toString().isNotEmpty() ? record->getProperty("missingSince") : juce::var(nowIso))
                    : juce::var()) || recordChanged;

                auto fileSha256 = normaliseNAMSha256(record->getProperty("fileSha256").toString());
                const bool validFileSha256 = fileSha256.length() == 64
                    && fileSha256.containsOnly("0123456789abcdef");
                if (! missing && ! validFileSha256)
                {
                    juce::String hashError;
                    if (calculateNAMAssetSha256(localFile, fileSha256, hashError))
                        recordChanged = setNAMRecordPropertyIfChanged(*record, "fileSha256", fileSha256) || recordChanged;
                }

                juce::String assetId;
                if (fileSha256.length() == 64 && fileSha256.containsOnly("0123456789abcdef"))
                {
                    assetId = "sha256:" + fileSha256;
                }
                else
                {
                    const int modelId = static_cast<int>(record->getProperty("modelId"));
                    if (modelId > 0)
                    {
                        auto provider = record->getProperty("sourceProvider").toString().trim().toLowerCase();
                        if (provider.isEmpty())
                            provider = "tone3000";
                        assetId = provider + ":model:" + juce::String(modelId);
                    }
                }
                recordChanged = setNAMRecordPropertyIfChanged(*record, "assetId", assetId) || recordChanged;

                if (!record->hasProperty("favorite"))
                {
                    record->setProperty("favorite", false);
                    recordChanged = true;
                }

                if (!record->hasProperty("sourceProvider"))
                {
                    record->setProperty("sourceProvider", record->getProperty("source").toString().isNotEmpty()
                        ? record->getProperty("source")
                        : juce::var("tone3000"));
                    recordChanged = true;
                }

                const auto catalogMatch = findCatalogModelForInstalledNAMRecord(catalog, record);
                auto* latestModel = catalogMatch.model.getDynamicObject();
                auto* latestTone = catalogMatch.tone.getDynamicObject();
                const auto updateReason = getNAMCatalogUpdateReason(record, latestModel, catalogMatch.exactModelId);
                const bool updateAvailable = updateReason.isNotEmpty();
                recordChanged = setNAMRecordPropertyIfChanged(*record, "updateAvailable", updateAvailable) || recordChanged;
                recordChanged = setNAMRecordPropertyIfChanged(*record, "updateReason", updateReason) || recordChanged;
                recordChanged = setNAMRecordPropertyIfChanged(*record, "catalogSeenAt", catalogGeneratedAt) || recordChanged;

                if (latestModel != nullptr)
                {
                    const int latestModelId = getModelObjectInt(latestModel, "id", "model_id");
                    const int latestToneId = latestTone != nullptr ? getModelObjectInt(latestTone, "id", "toneId") : static_cast<int>(record->getProperty("toneId"));
                    const auto latestModelUrl = getModelObjectString(latestModel, "model_url", "modelUrl");
                    recordChanged = setNAMRecordPropertyIfChanged(*record, "latestModelId", latestModelId) || recordChanged;
                    recordChanged = setNAMRecordPropertyIfChanged(*record, "latestToneId", latestToneId) || recordChanged;
                    recordChanged = setNAMRecordPropertyIfChanged(*record, "latestModelUrl", latestModelUrl) || recordChanged;
                    recordChanged = setNAMRecordObjectPropertyIfChanged(*record, "latestMetadata", catalogMatch.model) || recordChanged;
                    recordChanged = setNAMRecordPropertyIfChanged(*record, "latestMatchExact", catalogMatch.exactModelId) || recordChanged;
                    recordChanged = setNAMRecordPropertyIfChanged(*record, "lastSeenAt", catalogGeneratedAt.isNotEmpty() ? juce::var(catalogGeneratedAt) : juce::var(nowIso)) || recordChanged;
                }
                else
                {
                    recordChanged = setNAMRecordPropertyIfChanged(*record, "latestModelId", 0) || recordChanged;
                    recordChanged = setNAMRecordPropertyIfChanged(*record, "latestToneId", 0) || recordChanged;
                    recordChanged = setNAMRecordPropertyIfChanged(*record, "latestModelUrl", juce::var()) || recordChanged;
                    recordChanged = setNAMRecordObjectPropertyIfChanged(*record, "latestMetadata", juce::var()) || recordChanged;
                    recordChanged = setNAMRecordPropertyIfChanged(*record, "latestMatchExact", false) || recordChanged;
                }

                if (recordChanged)
                    record->setProperty("manifestUpdatedAt", nowIso);

                changed = recordChanged || changed;
            }
        }
    }

    if (changed && persistIfChanged && ! persistNAMLibraryManifest(manifest))
        juce::Logger::writeToLog("NAM library: could not atomically persist the refreshed manifest");

    return manifest;
}

juce::var setNAMLibraryFavorite(int modelId, const juce::String& localPath, bool favorite)
{
    const juce::ScopedLock manifestLock(namLibraryMutationLock);
    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", false);

    auto manifest = refreshNAMLibraryManifest(false);
    auto* manifestObject = manifest.getDynamicObject();
    const auto installedVar = manifestObject != nullptr ? manifestObject->getProperty("installed") : juce::var();
    auto* installed = installedVar.getArray();
    if (installed == nullptr)
    {
        result->setProperty("error", "NAM library manifest is invalid");
        return juce::var(result.get());
    }

    for (auto& recordVar : *installed)
    {
        if (auto* record = recordVar.getDynamicObject())
        {
            if (namLibraryRecordMatches(record, modelId, localPath))
            {
                const auto nowIso = juce::Time::getCurrentTime().toISO8601(true);
                record->setProperty("favorite", favorite);
                record->setProperty("updatedAt", nowIso);
                record->setProperty("manifestUpdatedAt", nowIso);
                if (! persistNAMLibraryManifest(manifest))
                {
                    result->setProperty("error", "Could not persist the NAM library manifest");
                    return juce::var(result.get());
                }
                result->setProperty("success", true);
                result->setProperty("record", recordVar);
                return juce::var(result.get());
            }
        }
    }

    result->setProperty("error", "NAM model is not installed");
    return juce::var(result.get());
}

juce::var removeNAMModelFromLibrary(int modelId, const juce::String& localPath, bool deleteLocalFile)
{
    // Use the same ordering as preview discard: rack state first, then library.
    // Physical deletion remains disabled until the engine can prove that no rack,
    // preset, or project references the path.
    const juce::ScopedLock stateLock(namModelMutationStateLock);
    const juce::ScopedLock manifestLock(namLibraryMutationLock);
    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", false);

    auto manifest = refreshNAMLibraryManifest(false);
    auto* manifestObject = manifest.getDynamicObject();
    const auto installedVar = manifestObject != nullptr ? manifestObject->getProperty("installed") : juce::var();
    auto* installedArray = installedVar.getArray();
    if (installedArray == nullptr)
    {
        result->setProperty("error", "NAM library manifest is invalid");
        return juce::var(result.get());
    }

    juce::Array<juce::var> kept;
    int removed = 0;
    const bool deletedFile = false;
    bool deleteSkipped = false;
    const bool deleteFailed = false;

    for (const auto& recordVar : *installedArray)
    {
        auto* record = recordVar.getDynamicObject();
        if (!namLibraryRecordMatches(record, modelId, localPath))
        {
            kept.add(recordVar);
            continue;
        }

        ++removed;
        if (deleteLocalFile && record != nullptr)
        {
            const auto path = record->getProperty("localPath").toString();
            const juce::File file(path);
            // Removing the manifest entry is safe, but physical deletion is not:
            // another rack, preset, or project may still reference this path.
            if (file.existsAsFile())
                deleteSkipped = true;
        }
    }

    if (removed <= 0)
    {
        result->setProperty("error", "NAM model is not installed");
        return juce::var(result.get());
    }

    manifestObject->setProperty("installed", kept);
    if (! persistNAMLibraryManifest(manifest))
    {
        result->setProperty("error", "Could not persist the NAM library manifest");
        return juce::var(result.get());
    }
    result->setProperty("success", true);
    result->setProperty("removed", removed);
    result->setProperty("deletedFile", deletedFile);
    result->setProperty("deleteSkipped", deleteSkipped);
    result->setProperty("deleteFailed", deleteFailed);
    if (deleteSkipped)
    {
        result->setProperty("retained", true);
        result->setProperty("recoverable", true);
        result->setProperty("warning",
            "The NAM file was retained because host-wide rack references cannot yet be proven clear");
    }
    return juce::var(result.get());
}

juce::var installNAMModelFromMetadata(juce::var modelPayload, bool previewMode = false)
{
    if (modelPayload.isString())
        modelPayload = juce::JSON::parse(modelPayload.toString());

    auto* model = modelPayload.getDynamicObject();
    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", false);
    if (model == nullptr)
    {
        result->setProperty("error", "Invalid NAM model metadata");
        return juce::var(result.get());
    }

    const auto modelUrl = getModelObjectString(model, "model_url", "modelUrl");
    if (modelUrl.isEmpty())
    {
        result->setProperty("error", "Model metadata does not include model_url");
        return juce::var(result.get());
    }

    const int modelId = getModelObjectInt(model, "id", "model_id");
    const int toneId = getModelObjectInt(model, "tone_id", "toneId");
    const auto displayName = getModelObjectString(model, "name", "title");
    const auto architecture = getModelObjectString(model, "architecture_version", "architecture");
    const auto sourceUrl = getModelObjectString(model, "source_url", "sourceUrl");
    const auto license = getModelObjectString(model, "license_name", "license");
    const auto creator = getModelObjectString(model, "creator_name", "creator");
    const auto gearType = getModelObjectString(model, "gear_type", "gearType");
    const auto toneTitle = getModelObjectString(model, "tone_title", "toneTitle");
    const auto checksum = getModelObjectString(model, "sha256", "checksum");
    const auto downloadExtension = getTone3000DownloadExtension(modelUrl);
    const auto gearTypeLower = gearType.toLowerCase();
    const bool looksLikeCabIR = gearTypeLower.contains("ir")
                             || gearTypeLower.contains("cab")
                             || isTone3000AudioIRExtension(downloadExtension);
    const auto fileStem = sanitizeNAMFileName(
        "tone-" + juce::String(toneId > 0 ? toneId : 0)
        + "-model-" + juce::String(modelId > 0 ? modelId : 0)
        + "-" + (displayName.isNotEmpty() ? displayName : "nam"));
    const auto toneFolderName = "tone-" + juce::String(toneId > 0 ? toneId : 0);
    const auto targetDir = previewMode
        ? getOpenStudioNAMRoot().getChildFile("previews").getChildFile(toneFolderName)
        : getOpenStudioNAMRoot().getChildFile("library").getChildFile(toneFolderName);
    const auto directoryResult = targetDir.createDirectory();
    if (directoryResult.failed())
    {
        result->setProperty("error", "Could not create the NAM download directory: " + directoryResult.getErrorMessage());
        return juce::var(result.get());
    }

    auto targetFile = targetDir.getChildFile(fileStem);
    if (targetFile.getFileExtension().isEmpty())
        targetFile = targetFile.withFileExtension(looksLikeCabIR && isTone3000AudioIRExtension(downloadExtension) ? downloadExtension : ".nam");
    const auto libraryFileName = targetFile.getFileName();
    if (previewMode)
    {
        const auto previewSuffix = "-preview-" + juce::Uuid().toString().substring(0, 12);
        targetFile = targetFile.getSiblingFile(
            targetFile.getFileNameWithoutExtension() + previewSuffix + targetFile.getFileExtension());
    }

    const auto token = getStoredTone3000AccessToken();
    if (token.isEmpty())
    {
        result->setProperty("error", "Missing TONE3000 access token. Connect TONE3000 first.");
        return juce::var(result.get());
    }

    auto download = openAuthenticatedNAMDownload(modelUrl, token);

    if (download.input == nullptr || download.statusCode >= 400)
    {
        auto error = download.error;
        if (error.isEmpty())
            error = "Download failed" + (download.statusCode > 0
                ? " (HTTP " + juce::String(download.statusCode) + ")"
                : juce::String());
        result->setProperty("error", error);
        return juce::var(result.get());
    }

    juce::TemporaryFile temporaryDownload(targetFile, juce::TemporaryFile::useHiddenFile);
    const auto& downloadedFile = temporaryDownload.getFile();
    {
        juce::FileOutputStream output(downloadedFile);
        if (! output.openedOk())
        {
            result->setProperty("error", "Could not create a temporary NAM download file");
            return juce::var(result.get());
        }

        constexpr juce::int64 maxDownloadBytes = 1024LL * 1024LL * 1024LL;
        const auto declaredLength = download.input->getTotalLength();
        if (declaredLength > maxDownloadBytes)
        {
            result->setProperty("error", "The NAM model download exceeds the 1 GB safety limit");
            return juce::var(result.get());
        }

        std::array<char, 64 * 1024> buffer {};
        juce::int64 bytesWritten = 0;
        while (! download.input->isExhausted())
        {
            const auto bytesRead = download.input->read(buffer.data(), static_cast<int>(buffer.size()));
            if (bytesRead <= 0)
                break;
            if (bytesWritten + bytesRead > maxDownloadBytes)
            {
                result->setProperty("error", "The NAM model download exceeds the 1 GB safety limit");
                return juce::var(result.get());
            }
            if (! output.write(buffer.data(), static_cast<size_t>(bytesRead)))
            {
                result->setProperty("error", "Could not write the temporary NAM download file");
                return juce::var(result.get());
            }
            bytesWritten += bytesRead;
        }
        output.flush();
        if (bytesWritten <= 0
            || (declaredLength >= 0 && bytesWritten != declaredLength)
            || output.getStatus().failed())
        {
            result->setProperty("error", "The NAM model download was incomplete");
            return juce::var(result.get());
        }
    }

    if (! downloadedFile.existsAsFile() || downloadedFile.getSize() <= 0)
    {
        result->setProperty("error", "Downloaded file was empty");
        return juce::var(result.get());
    }

    juce::String actualSha256;
    juce::String checksumError;
    if (! verifyNAMFileSha256(downloadedFile, checksum, actualSha256, checksumError))
    {
        result->setProperty("error", checksumError + " The temporary download was discarded and was not installed.");
        return juce::var(result.get());
    }

    // The download uses a unique temporary file and needs no shared lock. Hold
    // the process-wide lock from publication through manifest persistence so
    // concurrent windows cannot lose one another's installed records.
    std::unique_ptr<juce::ScopedLock> manifestLock;
    if (! previewMode)
        manifestLock = std::make_unique<juce::ScopedLock>(namLibraryMutationLock);

    if (! temporaryDownload.overwriteTargetFileWithTemporary())
    {
        result->setProperty("error", "Could not publish the verified NAM download into the library");
        return juce::var(result.get());
    }

    auto manifest = parseJsonFileOrDefault(getOpenStudioNAMManifestJson(), "installed");
    auto* manifestObject = manifest.getDynamicObject();
    juce::Array<juce::var> installed;
    bool preservedFavorite = false;
    bool replacedExistingRecord = false;
    juce::String preservedInstalledAt;
    if (manifestObject != nullptr)
    {
        const auto installedVar = manifestObject->getProperty("installed");
        if (auto* existingArray = installedVar.getArray())
            installed = *existingArray;
    }

    const auto nowIso = juce::Time::getCurrentTime().toISO8601(true);
    juce::DynamicObject::Ptr record = new juce::DynamicObject();
    record->setProperty("modelId", modelId);
    record->setProperty("toneId", toneId);
    record->setProperty("name", displayName);
    record->setProperty("architecture", architecture);
    record->setProperty("modelUrl", modelUrl);
    record->setProperty("sourceUrl", sourceUrl);
    record->setProperty("license", license);
    record->setProperty("creator", creator);
    record->setProperty("gearType", gearType);
    record->setProperty("toneTitle", toneTitle);
    record->setProperty("checksum", normaliseNAMSha256(checksum));
    record->setProperty("fileSha256", actualSha256);
    record->setProperty("assetId", "sha256:" + actualSha256);
    record->setProperty("checksumVerified", checksum.trim().isNotEmpty());
    record->setProperty("localPath", targetFile.getFullPathName());
    record->setProperty("libraryFileName", libraryFileName);
    record->setProperty("source", "tone3000");
    record->setProperty("sourceProvider", "tone3000");
    record->setProperty("preview", previewMode);
    record->setProperty("missing", false);
    record->setProperty("missingSince", juce::var());
    record->setProperty("fileSizeBytes", static_cast<double>(targetFile.getSize()));
    record->setProperty("lastSeenMetadata", modelPayload);
    record->setProperty("lastSeenAt", nowIso);
    record->setProperty("catalogSeenAt", nowIso);
    record->setProperty("manifestUpdatedAt", nowIso);
    record->setProperty("installedAt", nowIso);
    record->setProperty("updatedAt", nowIso);
    record->setProperty("reinstalled", false);
    record->setProperty("favorite", false);

    if (! previewMode && manifestObject != nullptr)
    {
        for (int i = installed.size() - 1; i >= 0; --i)
        {
            if (auto* existing = installed.getReference(i).getDynamicObject())
            {
                const bool sameModel = static_cast<int>(existing->getProperty("modelId")) == modelId && modelId > 0;
                const bool samePath = existing->getProperty("localPath").toString() == targetFile.getFullPathName();
                if (sameModel || samePath)
                {
                    replacedExistingRecord = true;
                    preservedFavorite = preservedFavorite || static_cast<bool>(existing->getProperty("favorite"));
                    if (preservedInstalledAt.isEmpty())
                        preservedInstalledAt = existing->getProperty("installedAt").toString();
                    installed.remove(i);
                }
            }
        }
        record->setProperty("reinstalled", replacedExistingRecord);
        record->setProperty("favorite", preservedFavorite);
        installed.add(juce::var(record.get()));
        manifestObject->setProperty("installed", installed);
    }

    if (! previewMode && ! persistNAMLibraryManifest(manifest))
    {
        result->setProperty("error", "Could not persist the NAM library manifest after download");
        return juce::var(result.get());
    }
    result->setProperty("success", true);
    result->setProperty("record", juce::var(record.get()));
    return juce::var(result.get());
}

juce::var commitNAMPreviewToneToLibrary(juce::var recordPayload, juce::var metadataPayload, juce::var rackStatePayload)
{
    const juce::ScopedLock manifestLock(namLibraryMutationLock);
    if (recordPayload.isString())
        recordPayload = juce::JSON::parse(recordPayload.toString());
    if (metadataPayload.isString())
        metadataPayload = juce::JSON::parse(metadataPayload.toString());
    if (rackStatePayload.isString())
        rackStatePayload = juce::JSON::parse(rackStatePayload.toString());

    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", false);

    auto* record = recordPayload.getDynamicObject();
    if (record == nullptr)
    {
        result->setProperty("error", "Invalid NAM preview record");
        return juce::var(result.get());
    }

    const auto localPath = record->getProperty("localPath").toString();
    if (localPath.isEmpty())
    {
        result->setProperty("error", "Preview record has no local file");
        return juce::var(result.get());
    }

    juce::File sourceFile(localPath);
    if (! sourceFile.existsAsFile())
    {
        result->setProperty("error", "Preview file is missing");
        return juce::var(result.get());
    }

    auto expectedPreviewSha256 = record->getProperty("fileSha256").toString();
    if (expectedPreviewSha256.isEmpty())
        expectedPreviewSha256 = record->getProperty("checksum").toString();

    juce::String actualPreviewSha256;
    juce::String checksumError;
    if (! verifyNAMFileSha256(sourceFile, expectedPreviewSha256, actualPreviewSha256, checksumError))
    {
        result->setProperty("error", checksumError
            + " The preview was not promoted; its source file was retained so the rack can still recover or revert safely.");
        return juce::var(result.get());
    }

    const int modelId = static_cast<int>(record->getProperty("modelId"));
    const int toneId = static_cast<int>(record->getProperty("toneId"));
    auto finalFile = sourceFile;
    if (isFileInsideNAMPreviews(sourceFile))
    {
        const auto targetDir = getOpenStudioNAMRoot()
            .getChildFile("library")
            .getChildFile("tone-" + juce::String(toneId > 0 ? toneId : 0));
        const auto directoryResult = targetDir.createDirectory();
        if (directoryResult.failed())
        {
            result->setProperty("error", "Could not create the NAM library directory: " + directoryResult.getErrorMessage());
            return juce::var(result.get());
        }

        auto libraryFileName = record->getProperty("libraryFileName").toString().trim();
        if (libraryFileName.isEmpty())
            libraryFileName = sourceFile.getFileName();
        libraryFileName = juce::File::createLegalFileName(libraryFileName);
        if (libraryFileName.isEmpty())
        {
            result->setProperty("error", "Could not derive a safe NAM library file name");
            return juce::var(result.get());
        }

        auto targetFile = targetDir.getChildFile(libraryFileName);
        juce::TemporaryFile promotedFile(targetFile, juce::TemporaryFile::useHiddenFile);
        if (! sourceFile.copyFileTo(promotedFile.getFile())
            || ! promotedFile.overwriteTargetFileWithTemporary()
            || ! targetFile.existsAsFile())
        {
            result->setProperty("error", "Could not copy the verified preview into the NAM library");
            return juce::var(result.get());
        }
        finalFile = targetFile;
    }

    auto manifest = parseJsonFileOrDefault(getOpenStudioNAMManifestJson(), "installed");
    auto* manifestObject = manifest.getDynamicObject();
    const auto installedVar = manifestObject != nullptr ? manifestObject->getProperty("installed") : juce::var();
    auto* installedArray = installedVar.getArray();
    if (manifestObject == nullptr || installedArray == nullptr)
    {
        result->setProperty("error", "NAM library manifest is invalid");
        return juce::var(result.get());
    }

    juce::Array<juce::var> installed = *installedArray;
    bool preservedFavorite = static_cast<bool>(record->getProperty("favorite"));
    juce::String preservedInstalledAt = record->getProperty("installedAt").toString();
    const auto nowIso = juce::Time::getCurrentTime().toISO8601(true);

    for (int i = installed.size() - 1; i >= 0; --i)
    {
        if (auto* existing = installed.getReference(i).getDynamicObject())
        {
            const bool sameModel = modelId > 0 && static_cast<int>(existing->getProperty("modelId")) == modelId;
            const bool samePath = existing->getProperty("localPath").toString() == finalFile.getFullPathName();
            if (sameModel || samePath)
            {
                preservedFavorite = preservedFavorite || static_cast<bool>(existing->getProperty("favorite"));
                if (preservedInstalledAt.isEmpty())
                    preservedInstalledAt = existing->getProperty("installedAt").toString();
                installed.remove(i);
            }
        }
    }

    if (auto* metadata = metadataPayload.getDynamicObject())
        preservedFavorite = preservedFavorite || static_cast<bool>(metadata->getProperty("favorite"));

    record->setProperty("localPath", finalFile.getFullPathName());
    record->setProperty("preview", false);
    record->setProperty("missing", false);
    record->setProperty("missingSince", juce::var());
    record->setProperty("fileSizeBytes", static_cast<double>(finalFile.getSize()));
    record->setProperty("fileSha256", actualPreviewSha256);
    record->setProperty("assetId", "sha256:" + actualPreviewSha256);
    record->setProperty("installedAt", preservedInstalledAt.isNotEmpty() ? preservedInstalledAt : nowIso);
    record->setProperty("updatedAt", nowIso);
    record->setProperty("manifestUpdatedAt", nowIso);
    record->setProperty("favorite", preservedFavorite);
    record->setProperty("saveMetadata", metadataPayload);
    record->setProperty("rackState", rackStatePayload);

    installed.add(recordPayload);
    manifestObject->setProperty("installed", installed);
    if (! persistNAMLibraryManifest(manifest))
    {
        result->setProperty("error", "Could not persist the NAM library manifest after preview promotion");
        return juce::var(result.get());
    }

    result->setProperty("success", true);
    result->setProperty("record", recordPayload);
    return juce::var(result.get());
}

juce::var discardNAMPreviewFile(juce::var recordPayload)
{
    if (recordPayload.isString())
        recordPayload = juce::JSON::parse(recordPayload.toString());

    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", false);

    auto* record = recordPayload.getDynamicObject();
    const auto localPath = record != nullptr ? record->getProperty("localPath").toString() : juce::String();
    if (localPath.isEmpty())
    {
        result->setProperty("error", "Invalid NAM preview record");
        return juce::var(result.get());
    }

    juce::File file(localPath);
    if (! isFileInsideNAMPreviews(file))
    {
        result->setProperty("success", true);
        result->setProperty("deleteSkipped", true);
        result->setProperty("retained", file.existsAsFile());
        result->setProperty("recoverable", file.existsAsFile());
        return juce::var(result.get());
    }

    if (! file.existsAsFile())
    {
        result->setProperty("success", true);
        result->setProperty("deletedFile", false);
        result->setProperty("alreadyMissing", true);
        return juce::var(result.get());
    }

    return makeNAMPreviewRetentionResult(
        "The NAM preview was retained because host-wide rack references cannot yet be proven clear");
}

juce::var cleanupNAMPreviewFiles(double maxAgeHours)
{
    juce::ignoreUnused(maxAgeHours);
    juce::DynamicObject::Ptr result = new juce::DynamicObject();
    result->setProperty("success", false);
    result->setProperty("cleaned", 0);
    result->setProperty("deleteSkipped", true);
    result->setProperty("error",
        "Bulk NAM preview cleanup is disabled because the host cannot yet prove that every rack has released each file");
    return juce::var(result.get());
}

bool isLocalFrontendDevServerReachable()
{
    if (juce::SystemStats::getEnvironmentVariable ("OPENSTUDIO_FORCE_PACKAGED_FRONTEND", {}).trim() == "1")
    {
        juce::Logger::writeToLog("OPENSTUDIO_FORCE_PACKAGED_FRONTEND=1; loading the packaged frontend.");
        return false;
    }

    int statusCode = 0;
    auto input = juce::URL("http://127.0.0.1:5183/").createInputStream(
        juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs(750)
            .withNumRedirectsToFollow(1)
            .withStatusCode(&statusCode));

    if (input == nullptr)
        return false;

    if (statusCode >= 400)
    {
        juce::Logger::writeToLog("localhost:5183 responded with HTTP " + juce::String(statusCode)
                                 + "; falling back to the packaged frontend.");
        return false;
    }

    const auto indexHtml = input->readEntireStreamAsString();
    const bool looksLikeOpenStudioVite =
        indexHtml.contains("<title>OpenStudio")
        && indexHtml.contains("id=\"root\"")
        && (indexHtml.contains("/src/main.tsx") || indexHtml.contains("./src/main.tsx"));

    if (! looksLikeOpenStudioVite)
    {
        juce::Logger::writeToLog("localhost:5183 is reachable, but it did not return the OpenStudio Vite index; "
                                 "falling back to the packaged frontend.");
        return false;
    }

    return true;
}

juce::String appendFrontendStartupQuery(const juce::String& baseUrl,
                                        MainComponent::WindowRole role,
                                        MainComponent::StartupMode startupMode,
                                        const juce::String& windowInstanceId = {})
{
    juce::String url = baseUrl;
    const auto appendParameter = [&url](const juce::String& key, const juce::String& value)
    {
        const auto separator = url.containsChar('?') ? "&" : "?";
        url << separator << key << "=" << juce::URL::addEscapeChars(value, true);
    };

    appendParameter("window", getWindowRoleQueryValue(role));
    appendParameter("startup", getStartupModeQueryValue(startupMode));
    appendParameter("platform", getHostPlatformQueryValue());
    appendParameter("windowChrome", getWindowChromeQueryValue(role));
    if (windowInstanceId.isNotEmpty())
        appendParameter("sessionId", windowInstanceId);
    appendParameter("cacheBust", juce::String(juce::Time::getCurrentTime().toMilliseconds()));
    return url;
}

juce::String describeFrontendStartupState(MainComponent::FrontendStartupState state)
{
    switch (state)
    {
        case MainComponent::FrontendStartupState::idle: return "idle";
        case MainComponent::FrontendStartupState::navigationStarted: return "navigation-started";
        case MainComponent::FrontendStartupState::bootStarted: return "boot-started";
        case MainComponent::FrontendStartupState::ready: return "ready";
        case MainComponent::FrontendStartupState::failed: return "failed";
        case MainComponent::FrontendStartupState::timedOut: return "timed-out";
    }

    return "unknown";
}

juce::String determineStartupFailureCategory(const StartupDependencyStatus& dependencyStatus)
{
    if (! dependencyStatus.shellRuntimeAssetsPresent)
        return dependencyStatus.packagedFrontendPresent ? "shell-assets-missing" : "packaged-frontend-missing";

#if JUCE_WINDOWS
    if (! dependencyStatus.browserBackendSupported)
    {
        if (! dependencyStatus.vcRedistInstalled)
            return "vc-redist-missing";

        if (dependencyStatus.webView2RuntimeVersion.isEmpty())
            return "webview2-runtime-missing";

        return "webview2-backend-unusable";
    }
#else
    if (! dependencyStatus.browserBackendSupported)
        return "macos-backend-unavailable";
#endif

    return "ready";
}

juce::String buildStartupFailureSummary(const StartupDependencyStatus& dependencyStatus)
{
    const auto failureCategory = determineStartupFailureCategory(dependencyStatus);

    if (failureCategory == "packaged-frontend-missing")
        return "Packaged frontend is missing.";

    if (failureCategory == "shell-assets-missing")
        return "Required shell assets are missing.";

#if JUCE_WINDOWS
    if (failureCategory == "vc-redist-missing")
        return "Microsoft Visual C++ Redistributable is missing.";

    if (failureCategory == "webview2-runtime-missing")
        return "Microsoft Edge WebView2 Runtime is missing.";

    if (failureCategory == "webview2-backend-unusable")
        return "WebView2 Runtime was detected, but JUCE still reports the backend as unavailable.";
#else
    if (failureCategory == "macos-backend-unavailable")
        return "The system browser backend is unavailable on this macOS installation.";
#endif

    return "OpenStudio shell startup self-test passed.";
}

juce::String buildStartupSelfTestText(const StartupDependencyStatus& dependencyStatus)
{
    juce::StringArray lines;
    lines.add("OpenStudio Startup Self-Test");
    lines.add("shellReady=" + juce::String(determineStartupFailureCategory(dependencyStatus) == "ready" ? "true" : "false"));
    lines.add("failureCategory=" + determineStartupFailureCategory(dependencyStatus));
    lines.add("summary=" + buildStartupFailureSummary(dependencyStatus));
    lines.add("browserBackend=" + dependencyStatus.browserBackend);
    lines.add("browserBackendSupported=" + juce::String(dependencyStatus.browserBackendSupported ? "true" : "false"));
    lines.add("packagedFrontendPresent=" + juce::String(dependencyStatus.packagedFrontendPresent ? "true" : "false"));
    lines.add("packagedFrontendPath=" + dependencyStatus.packagedFrontendPath);
    lines.add("shellRuntimeAssetsPresent=" + juce::String(dependencyStatus.shellRuntimeAssetsPresent ? "true" : "false"));
    lines.add("missingShellRuntimeAssets=" + dependencyStatus.missingShellRuntimeAssets.joinIntoString(" | "));
    lines.add("featureRuntimeAssetsPresent=" + juce::String(dependencyStatus.featureRuntimeAssetsPresent ? "true" : "false"));
    lines.add("missingFeatureRuntimeAssets=" + dependencyStatus.missingFeatureRuntimeAssets.joinIntoString(" | "));
    lines.add("startupLogPath=" + getStartupLogFile().getFullPathName());
#if JUCE_WINDOWS
    lines.add("webView2UserDataPath=" + getWebView2UserDataFolder().getFullPathName());
    lines.add("webView2RuntimeVersion=" + dependencyStatus.webView2RuntimeVersion);
    lines.add("vcRedistInstalled=" + juce::String(dependencyStatus.vcRedistInstalled ? "true" : "false"));
    lines.add("vcRedistVersion=" + dependencyStatus.vcRedistVersion);
    lines.add("prerequisiteRepairAvailable=" + juce::String(dependencyStatus.repairAvailable ? "true" : "false"));
#endif
    return lines.joinIntoString("\n");
}

juce::StringArray getNAMModelMutationSlots(const juce::String& stateJson)
{
    juce::StringArray slots;
    const auto parsed = juce::JSON::parse(stateJson);
    auto* stateObject = parsed.getDynamicObject();
    if (stateObject == nullptr)
        return slots;

    auto* modelObject = stateObject->getProperty("modelState").getDynamicObject();
    if (modelObject == nullptr)
        modelObject = stateObject;

    const auto addIfTouched = [modelObject, &slots](const juce::Identifier& pathProperty,
                                                    const juce::Identifier& clearProperty,
                                                    const juce::String& slot)
    {
        const bool hasPathMutation = modelObject->hasProperty(pathProperty);
        const bool hasClearMutation = modelObject->hasProperty(clearProperty)
            && static_cast<bool>(modelObject->getProperty(clearProperty));
        if (hasPathMutation || hasClearMutation)
            slots.addIfNotAlreadyThere(slot);
    };

    addIfTouched("pedalModelPath", "clearPedalModel", "pedal");
    addIfTouched("ampModelPath", "clearAmpModel", "amp");
    addIfTouched("cabIRPath", "clearCabIR", "cab");
    if (modelObject->hasProperty("pedalModelSize"))
        slots.addIfNotAlreadyThere("pedal");
    if (modelObject->hasProperty("ampModelSize"))
        slots.addIfNotAlreadyThere("amp");
    bool legacyModelSizeTouched = false;
    if (auto* values =
            stateObject->getProperty(
                "values").getDynamicObject())
    {
        legacyModelSizeTouched =
            values->hasProperty("namModelSize");
    }
    if (auto* parameters =
            stateObject->getProperty(
                "parameters").getArray())
    {
        for (const auto& parameterValue :
             *parameters)
        {
            if (auto* parameter =
                    parameterValue.getDynamicObject();
                parameter != nullptr
                && parameter->getProperty(
                       "id").toString()
                    == "namModelSize")
            {
                legacyModelSizeTouched = true;
                break;
            }
        }
    }
    if (legacyModelSizeTouched)
    {
        slots.addIfNotAlreadyThere("pedal");
        slots.addIfNotAlreadyThere("amp");
    }
    return slots;
}
}

juce::CriticalSection MainComponent::instanceListLock;
juce::Array<MainComponent*> MainComponent::activeInstances;

std::string MainComponent::makeNAMModelMutationKey(const juce::String& trackId,
                                                   const juce::String& chainType,
                                                   int fxIndex,
                                                   const juce::String& slot)
{
    return (trackId + "\x1f" + chainType + "\x1f" + juce::String(fxIndex)
            + "\x1f" + slot.trim().toLowerCase()).toStdString();
}

juce::uint64 MainComponent::beginNAMModelMutationRequest(const juce::String& trackId,
                                                         const juce::String& chainType,
                                                         int fxIndex,
                                                         const juce::String& slot)
{
    const juce::ScopedLock sl(namModelMutationGenerationLock);
    const auto generation = ++nextNAMModelMutationGeneration;
    namModelMutationGenerations[makeNAMModelMutationKey(trackId, chainType, fxIndex, slot)] = generation;
    return generation;
}

juce::uint64 MainComponent::beginNAMModelMutationRequests(
    const juce::String& trackId,
    const juce::String& chainType,
    int fxIndex,
    const juce::StringArray& slots,
    std::vector<std::pair<juce::String, juce::uint64>>& requests)
{
    const juce::ScopedLock generationLock(namModelMutationGenerationLock);
    requests.clear();
    requests.reserve(static_cast<size_t>(slots.size()));
    for (const auto& slot : slots)
    {
        const auto generation = ++nextNAMModelMutationGeneration;
        namModelMutationGenerations[makeNAMModelMutationKey(trackId, chainType, fxIndex, slot)] = generation;
        requests.emplace_back(slot, generation);
    }
    return namRackTopologyGeneration;
}

void MainComponent::invalidateNAMModelMutationRequests(const juce::String& trackId,
                                                       const juce::String& chainType,
                                                       int fxIndex,
                                                       const juce::StringArray& slots)
{
    for (const auto& slot : slots)
        beginNAMModelMutationRequest(trackId, chainType, fxIndex, slot);
}

bool MainComponent::isNAMModelMutationRequestCurrent(const juce::String& trackId,
                                                     const juce::String& chainType,
                                                     int fxIndex,
                                                     const juce::String& slot,
                                                     juce::uint64 generation)
{
    const juce::ScopedLock sl(namModelMutationGenerationLock);
    const auto iterator = namModelMutationGenerations.find(makeNAMModelMutationKey(trackId, chainType, fxIndex, slot));
    return iterator != namModelMutationGenerations.end() && iterator->second == generation;
}

std::shared_ptr<void> MainComponent::acquireNAMModelMutationPublicationLease(
    const juce::String& trackId,
    const juce::String& chainType,
    int fxIndex,
    const std::vector<std::pair<juce::String, juce::uint64>>& requests,
    juce::uint64 topologyGeneration)
{
    // Expensive model/IR preparation happens before this lease is requested.
    // Acquire locks in the same state -> generation order as topology handlers,
    // then hold both only through the short validated audible publication. This
    // keeps render/freeze and topology mutations atomic without blocking the
    // WebView message thread for the duration of NAM graph construction.
    namModelMutationStateLock.enter();
    namModelMutationGenerationLock.enter();
    bool current = topologyGeneration == namRackTopologyGeneration;
    for (const auto& request : requests)
    {
        const auto iterator = namModelMutationGenerations.find(
            makeNAMModelMutationKey(trackId, chainType, fxIndex, request.first));
        current = current && iterator != namModelMutationGenerations.end()
            && iterator->second == request.second;
    }

    if (! current)
    {
        namModelMutationGenerationLock.exit();
        namModelMutationStateLock.exit();
        return {};
    }

    return std::shared_ptr<void>(
        &namModelMutationStateLock,
        [] (void*)
        {
            namModelMutationGenerationLock.exit();
            namModelMutationStateLock.exit();
        });
}

juce::var MainComponent::discardNAMPreviewIfUnused(juce::var recordPayload,
                                                    juce::var rackAddressPayload)
{
    // Lock ordering is always rack state first, file/library lifecycle second.
    // Neither lock is observed by the audio callback.
    const juce::ScopedLock stateLock(namModelMutationStateLock);
    const juce::ScopedLock libraryLock(namLibraryMutationLock);

    if (recordPayload.isString())
        recordPayload = juce::JSON::parse(recordPayload.toString());

    auto* record = recordPayload.getDynamicObject();
    const auto localPath = record != nullptr ? record->getProperty("localPath").toString() : juce::String();
    if (localPath.isEmpty())
        return discardNAMPreviewFile(recordPayload);

    const juce::File previewFile(localPath);
    if (! isFileInsideNAMPreviews(previewFile) || ! previewFile.existsAsFile())
        return discardNAMPreviewFile(recordPayload);

    // UUID previews created by current builds carry their deterministic library
    // destination separately. Legacy records did not, and their preview path may
    // be shared by more than one rack/window, so ownership cannot be proven.
    if (record->getProperty("libraryFileName").toString().trim().isEmpty())
    {
        return makeNAMPreviewRetentionResult(
            "Legacy NAM preview ownership cannot be proven; the file was retained safely");
    }

    if (rackAddressPayload.isString())
        rackAddressPayload = juce::JSON::parse(rackAddressPayload.toString());

    auto* address = rackAddressPayload.getDynamicObject();
    if (address != nullptr)
    {
        if (auto* nestedAddress = address->getProperty("address").getDynamicObject())
            address = nestedAddress;
    }

    if (address == nullptr)
    {
        return makeNAMPreviewRetentionResult(
            "NAM preview discard needs the target rack address so the model can be proven unloaded");
    }

    const auto trackId = address->getProperty("trackId").toString();
    auto chainType = address->getProperty("chain").toString().trim().toLowerCase();
    if (chainType.isEmpty())
        chainType = address->getProperty("chainType").toString().trim().toLowerCase();
    const int fxIndex = address->hasProperty("fxIndex")
        ? static_cast<int>(address->getProperty("fxIndex"))
        : -1;
    const bool supportedChain = chainType == "input" || chainType == "track" || chainType == "master";
    if (! supportedChain || fxIndex < 0 || (chainType != "master" && trackId.isEmpty()))
    {
        return makeNAMPreviewRetentionResult(
            "NAM preview discard received an invalid or incomplete target rack address");
    }

    // This addressed-rack check is diagnostic only. Physical deletion remains
    // disabled until every live NAM rack can be enumerated or reference-counted.
    const auto rackState = audioEngine.getBuiltInPluginState(trackId, chainType, fxIndex);
    auto* stateObject = rackState.getDynamicObject();
    auto* modelState = stateObject != nullptr
        ? stateObject->getProperty("modelState").getDynamicObject()
        : nullptr;
    if (modelState == nullptr)
    {
        return makeNAMPreviewRetentionResult(
            "Could not verify the current NAM Rack state; the preview was kept");
    }

    const struct
    {
        const char* property;
        const char* slot;
    } modelPaths[] {
        { "pedalModelPath", "pedal" },
        { "ampModelPath", "amp" },
        { "cabIRPath", "cab" },
    };

    for (const auto& candidate : modelPaths)
    {
        if (areNAMPathsEquivalent(localPath, modelState->getProperty(candidate.property).toString()))
        {
            return makeNAMPreviewRetentionResult(
                "NAM preview is still loaded in the " + juce::String(candidate.slot) + " slot",
                candidate.slot);
        }
    }

    return makeNAMPreviewRetentionResult(
        "The NAM preview was unloaded from the addressed rack but retained because other rack references cannot be proven clear");
}

juce::var MainComponent::buildStartupSelfTestReport()
{
    const auto checkOptions = getEmbeddedBrowserBaseOptions();
    const auto supported = juce::WebBrowserComponent::areOptionsSupported(checkOptions);
    const auto dependencyStatus = evaluateStartupDependencies(supported);

    auto* report = new juce::DynamicObject();
    report->setProperty("shellReady", determineStartupFailureCategory(dependencyStatus) == "ready");
    report->setProperty("failureCategory", determineStartupFailureCategory(dependencyStatus));
    report->setProperty("summary", buildStartupFailureSummary(dependencyStatus));
    report->setProperty("browserBackend", dependencyStatus.browserBackend);
    report->setProperty("browserBackendSupported", dependencyStatus.browserBackendSupported);
    report->setProperty("packagedFrontendPresent", dependencyStatus.packagedFrontendPresent);
    report->setProperty("packagedFrontendPath", dependencyStatus.packagedFrontendPath);
    report->setProperty("shellRuntimeAssetsPresent", dependencyStatus.shellRuntimeAssetsPresent);
    report->setProperty("missingShellRuntimeAssets", dependencyStatus.missingShellRuntimeAssets.joinIntoString("\n"));
    report->setProperty("featureRuntimeAssetsPresent", dependencyStatus.featureRuntimeAssetsPresent);
    report->setProperty("missingFeatureRuntimeAssets", dependencyStatus.missingFeatureRuntimeAssets.joinIntoString("\n"));
    report->setProperty("startupLogPath", getStartupLogFile().getFullPathName());
#if JUCE_WINDOWS
    report->setProperty("webView2UserDataPath", getWebView2UserDataFolder().getFullPathName());
    report->setProperty("webView2RuntimeVersion", dependencyStatus.webView2RuntimeVersion);
    report->setProperty("vcRedistInstalled", dependencyStatus.vcRedistInstalled);
    report->setProperty("vcRedistVersion", dependencyStatus.vcRedistVersion);
    report->setProperty("prerequisiteRepairAvailable", dependencyStatus.repairAvailable);
#endif
    report->setProperty("textReport", buildStartupSelfTestText(dependencyStatus));
    return juce::var(report);
}

bool MainComponent::writeStartupSelfTestReport(const juce::File& reportFile)
{
    const auto report = buildStartupSelfTestReport();
    const auto textReport = getStringProperty(report, "textReport");

    if (reportFile != juce::File())
    {
        reportFile.getParentDirectory().createDirectory();
        reportFile.replaceWithText(textReport);
    }

    juce::Logger::writeToLog("=== Startup self-test ===");
    juce::Logger::writeToLog(textReport);
    return static_cast<bool>(report.getProperty("shellReady", false));
}

//==============================================================================
MainComponent::MainComponent(AudioEngine& audioEngineIn,
                             AppUpdater& appUpdaterIn,
                             StartupMode startupModeIn,
                             WindowRole roleIn,
                             WindowCallbacks callbacksIn,
                             const juce::String& pitchRegressionJobPathIn,
                             const juce::String& windowInstanceIdIn)
    : audioEngine(audioEngineIn),
      appUpdater(appUpdaterIn),
      startupMode(startupModeIn),
      windowRole(roleIn),
      windowInstanceId(windowInstanceIdIn),
      windowCallbacks(std::move(callbacksIn)),
      webView (getEmbeddedBrowserBaseOptions()
                   .withNativeIntegrationEnabled()
                   .withResourceProvider ([this] (const juce::String& path) -> std::optional<juce::WebBrowserComponent::Resource> {
                       const auto requestedPath = path.upToFirstOccurrenceOf("?", false, false)
                                                     .upToFirstOccurrenceOf("#", false, false);
                       const auto normalisedRequestedPath = normaliseResourceRequestPath(path);
                       static constexpr auto startupRoutePrefix = "__openstudio__/startup";

                       if (normalisedRequestedPath == startupRoutePrefix
                           || normalisedRequestedPath.startsWithIgnoreCase(juce::String(startupRoutePrefix) + "/"))
                       {
                           juce::String state;
                           juce::String detail;

                           if (normalisedRequestedPath.startsWithIgnoreCase(juce::String(startupRoutePrefix) + "/"))
                           {
                               state = normalisedRequestedPath.fromFirstOccurrenceOf(juce::String(startupRoutePrefix) + "/", false, false)
                                                              .upToFirstOccurrenceOf("/", false, false)
                                                              .trim()
                                                              .toLowerCase();
                           }

                           if (state.isEmpty())
                           {
                               const auto requestUrl = juce::URL(juce::WebBrowserComponent::getResourceProviderRoot()
                                                                 + path.fromFirstOccurrenceOf("/", false, false));
                               const auto& parameterNames = requestUrl.getParameterNames();
                               const auto& parameterValues = requestUrl.getParameterValues();

                               for (int i = 0; i < parameterNames.size(); ++i)
                               {
                                   if (parameterNames[i] == "state")
                                       state = parameterValues[i].trim().toLowerCase();
                                   else if (parameterNames[i] == "detail")
                                       detail = parameterValues[i];
                               }
                           }

                           if (state.isEmpty())
                           {
                               juce::Logger::writeToLog("Frontend startup report received via resource provider: malformed request path="
                                                        + requestedPath + " normalised=" + normalisedRequestedPath);
                           }
                           else
                           {
                               juce::Logger::writeToLog("Frontend startup report received via resource provider: state=" + state
                                                        + (detail.isNotEmpty() ? " detail=" + detail : ""));
                           }
                           juce::Component::SafePointer<MainComponent> safeThis(this);

                           juce::MessageManager::callAsync([safeThis, state, detail]()
                           {
                               if (safeThis == nullptr || safeThis->secondaryWindowClosing)
                                   return;

                               if (state == "boot-started")
                               {
                                   safeThis->frontendStartupState = FrontendStartupState::bootStarted;
                                   safeThis->frontendStartupDetail = detail;
                                   juce::Logger::writeToLog("Frontend startup state: boot-started" + (detail.isNotEmpty() ? " - " + detail : ""));
                               }
                               else if (state == "boot-ready")
                               {
                                   safeThis->markFrontendStartupReady(detail);
                               }
                               else if (state == "boot-failed")
                               {
                                   safeThis->markFrontendStartupFailed(detail.isNotEmpty() ? detail : "The embedded frontend reported a startup failure.");
                               }
                               else
                               {
                                   juce::Logger::writeToLog("Frontend startup state: malformed or unknown resource-provider value '"
                                                            + state + "'" + (detail.isNotEmpty() ? " - " + detail : ""));
                               }
                           });

                           static constexpr char okResponse[] = "{\"ok\":true}";
                           const auto* begin = reinterpret_cast<const std::byte*>(okResponse);
                           return juce::WebBrowserComponent::Resource {
                               std::vector<std::byte>(begin, begin + sizeof(okResponse) - 1),
                               "application/json"
                           };
                       }

                       if (webuiDir == juce::File{} || ! webuiDir.isDirectory())
                       {
                           juce::Logger::writeToLog("Frontend resource request rejected because webuiDir is unavailable: " + path);
                           return std::nullopt;
                       }

                       const auto relativePath = normaliseResourceRequestPath(path);
                       if (! isSafeResourceRelativePath(relativePath))
                       {
                           juce::Logger::writeToLog("Frontend resource request rejected for unsafe path: " + path + " -> " + relativePath);
                           return std::nullopt;
                       }

                       const auto requestedFile = webuiDir.getChildFile(relativePath);
                       if (! requestedFile.existsAsFile())
                       {
                           juce::Logger::writeToLog("Frontend resource not found: " + relativePath);
                           return std::nullopt;
                       }

                       juce::MemoryBlock fileData;
                       if (! requestedFile.loadFileAsData(fileData))
                       {
                           juce::Logger::writeToLog("Frontend resource failed to load: " + requestedFile.getFullPathName());
                           return std::nullopt;
                       }

                       const auto mimeType = getMimeTypeForFrontendFile(requestedFile);
                       if (relativePath == "index.html" || relativePath.endsWith(".js") || relativePath.endsWith(".css"))
                           juce::Logger::writeToLog("Frontend resource served: " + relativePath + " (" + mimeType + ")");

                       const auto* begin = static_cast<const std::byte*>(fileData.getData());
                       return juce::WebBrowserComponent::Resource {
                           std::vector<std::byte>(begin, begin + fileData.getSize()),
                           mimeType
                       };
                   })
                   // CRITICAL: Add user script to expose native functions properly
                   .withUserScript(R"(
                       console.log("JUCE User Script: Initializing native functions...");
                       
                       // Helper to invoke native functions with timeout
                       window.__JUCE__.backend.getNativeFunction = function(name) {
                           return function(...args) {
                               return new Promise((resolve, reject) => {
                                   const resultId = Date.now() * 1000 + Math.floor(Math.random() * 1000);

                                   // Dialog functions are interactive — user may spend several minutes navigating.
                                   // Worker-backed startup calls may also legitimately take longer than the default bridge timeout.
                                   // Plug-in scans enforce a per-candidate timeout natively, so do not add a second
                                   // aggregate browser timeout that can expire while a healthy scan is still running.
                                   // Offline renders are duration-dependent and continue on a native worker thread;
                                   // a browser deadline would report failure while the valid output is still being written.
                                   // Use a 5-minute timeout for file choosers and AI generation startup, 15 seconds for everything else.
                                    const DIALOG_FUNCTIONS = ['showRenderSaveDialog', 'showSaveDialog', 'showOpenDialog', 'showOpenFileDialog', 'showDirectoryDialog', 'openAudioDeviceControlPanel'];
                                   const LONG_RUNNING_FUNCTIONS = ['startAIGeneration', 'refreshNAMCatalog'];
                                   const NO_TIMEOUT_FUNCTIONS = ['scanForPlugins', 'renderProject', 'renderProjectWithDither'];
                                   const timeoutMs = (DIALOG_FUNCTIONS.indexOf(name) >= 0 || LONG_RUNNING_FUNCTIONS.indexOf(name) >= 0) ? 300000 : 15000;
                                   const timeout = NO_TIMEOUT_FUNCTIONS.indexOf(name) >= 0
                                       ? null
                                       : setTimeout(() => {
                                           window.__JUCE__.backend.removeEventListener(listener);
                                           reject(new Error("Native function call timeout: " + name));
                                       }, timeoutMs);

                                   const listener = window.__JUCE__.backend.addEventListener('__juce__complete', (data) => {
                                       if (data.promiseId === resultId) {
                                           if (timeout !== null)
                                               clearTimeout(timeout);
                                           window.__JUCE__.backend.removeEventListener(listener);
                                           resolve(data.result);
                                       }
                                   });
                                   window.__JUCE__.backend.emitEvent('__juce__invoke', {
                                       name: name,
                                       params: args,
                                       resultId: resultId
                                   });
                               });
                           };
                       };
                       
                       // Expose functions directly as methods for easier access
                       if (window.__JUCE__.initialisationData && window.__JUCE__.initialisationData.__juce__functions) {
                           console.log("JUCE User Script: Registering functions:", window.__JUCE__.initialisationData.__juce__functions);
                           for (const funcName of window.__JUCE__.initialisationData.__juce__functions) {
                               window.__JUCE__.backend[funcName] = window.__JUCE__.backend.getNativeFunction(funcName);
                           }
                       }
                       
                       console.log("JUCE User Script: Initialization complete. Available functions:", Object.keys(window.__JUCE__.backend));
                   )")
                    .withNativeFunction ("getAudioDeviceSetup", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                         juce::ignoreUnused(args);
                         // Return the current audio setup as a JSON object
                         completion (audioEngine.getAudioDeviceSetup());
                    })
                    .withNativeFunction ("getNAMRackOversamplingFactor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                         juce::ignoreUnused(args);
                         completion(audioEngine.getNAMRackOversamplingFactor());
                    })
                    .withNativeFunction ("setNAMRackOversamplingFactor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                         if (args.size() != 1)
                         {
                             completion(false);
                             return;
                         }
                         const int factor = static_cast<int>(args[0]);
                         juce::MessageManager::callAsync(
                             [this, factor, completion = std::move(completion)]() mutable {
                                 completion(audioEngine.setNAMRackOversamplingFactor(factor));
                             });
                    })
                    .withNativeFunction ("openAudioDeviceControlPanel", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                         juce::ignoreUnused(args);
                         juce::MessageManager::callAsync(
                             [this, completion = std::move(completion)]() mutable {
                                 completion(audioEngine.openAudioDeviceControlPanel());
                             });
                    })
                    .withNativeFunction ("setAudioDeviceSetup", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Expecting: [type, input, output, sampleRate, bufferSize]
                        if (args.size() == 1 && args[0].isObject()) {
                           auto* obj = args[0].getDynamicObject();
                           juce::String type = obj->getProperty("type");
                           juce::String input = obj->getProperty("inputDevice");
                           juce::String output = obj->getProperty("outputDevice");
                           double sampleRate = obj->getProperty("sampleRate");
                           int bufferSize = obj->getProperty("bufferSize");
                           
                           // Device changes belong on the message thread. Resolve
                           // the JS promise only after JUCE has accepted (and
                           // verified) the actual setup so the UI cannot report a
                           // false success.
                           juce::MessageManager::callAsync([this, type, input, output, sampleRate, bufferSize,
                                                            completion = std::move(completion)]() mutable {
                               audioEngine.setAudioDeviceSetup(
                                   type,
                                   input,
                                   output,
                                   sampleRate,
                                   bufferSize,
                                   [completion = std::move(completion)](
                                       bool applied,
                                       const juce::String& errorMessage) mutable {
                                       if (! applied && errorMessage.isNotEmpty())
                                           juce::Logger::writeToLog(
                                               "setAudioDeviceSetup failed: " + errorMessage);
                                       completion(applied);
                                   });
                           });
                        } else {
                           completion(false);
                        }
                   })
                   .withNativeFunction ("reportFrontendStartupState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       const auto state = args.size() > 0 ? args[0].toString().trim().toLowerCase() : juce::String();
                       const auto detail = args.size() > 1 ? args[1].toString() : juce::String();
                       if (secondaryWindowClosing)
                       {
                           juce::Logger::writeToLog("Frontend startup report ignored after secondary close: state=" + state
                                                    + (detail.isNotEmpty() ? " detail=" + detail : ""));
                           completion(true);
                           return;
                       }

                       juce::Logger::writeToLog("Frontend startup report received via native function: state=" + state
                                                + (detail.isNotEmpty() ? " detail=" + detail : ""));

                       if (state == "boot-started")
                       {
                           frontendStartupState = FrontendStartupState::bootStarted;
                           frontendStartupDetail = detail;
                           juce::Logger::writeToLog("Frontend startup state: boot-started" + (detail.isNotEmpty() ? " - " + detail : ""));
                       }
                       else if (state == "boot-ready")
                       {
                           markFrontendStartupReady(detail);
                       }
                       else if (state == "boot-failed")
                       {
                           markFrontendStartupFailed(detail.isNotEmpty() ? detail : "The embedded frontend reported a startup failure.");
                       }
                       else
                       {
                           juce::Logger::writeToLog("Frontend startup state: unknown value '" + state + "'" + (detail.isNotEmpty() ? " - " + detail : ""));
                       }

                       completion(true);
                   })
                   .withNativeFunction ("getStartupDiagnostics", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(buildStartupDiagnostics());
                   })
                   .withNativeFunction ("addTrack", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::String explicitId = "";
                       if (args.size() > 0 && args[0].isString()) {
                           explicitId = args[0].toString();
                       }
                       juce::String initialType = "";
                       if (args.size() > 1 && args[1].isString()) {
                           initialType = args[1].toString();
                       }
                       const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                       invalidateNAMRackTopology();
                       juce::String trackId = audioEngine.addTrack(explicitId, initialType);
                       completion(trackId);
                   })
                   .withNativeFunction ("removeTrack", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() > 0 && args[0].isString())
                       {
                           const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                           invalidateNAMRackTopology();
                           bool success = audioEngine.removeTrack(args[0].toString());
                           completion(success);
                       }
                       else { completion(false); }
                   })
                   .withNativeFunction ("reorderTrack", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           int newPosition = args[1];
                           completion(audioEngine.reorderTrack(trackId, newPosition));
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackRecordArm", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           bool armed = args[1];
                           audioEngine.setTrackRecordArm(trackId, armed);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackInputMonitoring", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           bool enabled = args[1];
                           audioEngine.setTrackInputMonitoring(trackId, enabled);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackInputChannels", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 3) {
                           juce::String trackId = args[0].toString();
                           int startChannel = args[1];
                           int numChannels = args[2];
                           audioEngine.setTrackInputChannels(trackId, startChannel, numChannels);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setNAMTunerActive", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 2) {
                           const juce::String trackId = args[0].toString();
                           const bool active = args[1];
                           const juce::String subscriberId =
                               args.size() >= 3 ? args[2].toString() : juce::String();
                           completion(audioEngine.setNAMTunerActive(
                               trackId, active, subscriberId));
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackVolume", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           float volumeDB = args[1];
                           audioEngine.setTrackVolume(trackId, volumeDB);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackPan", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           float pan = args[1];
                           audioEngine.setTrackPan(trackId, pan);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackMute", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           bool muted = args[1];
                           audioEngine.setTrackMute(trackId, muted);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTrackSolo", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           bool soloed = args[1];
                           audioEngine.setTrackSolo(trackId, soloed);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTransportPlaying", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           bool playing = args[0];
                           OPENSTUDIO_LOG_AUDIO_BRIDGE("setTransportPlaying playing=" + juce::String(playing ? "true" : "false"));
                           audioEngine.setTransportPlaying(playing);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("setTransportRecording", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           bool recording = args[0];
                           OPENSTUDIO_LOG_AUDIO_BRIDGE("setTransportRecording recording=" + juce::String(recording ? "true" : "false"));
                           audioEngine.setTransportRecording(recording);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })

                   // Punch In/Out (Phase 3.1)
                   .withNativeFunction ("setPunchRange", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 3) {
                           double startTime = (double)args[0];
                           double endTime = (double)args[1];
                           bool enabled = (bool)args[2];
                           audioEngine.setPunchRange(startTime, endTime, enabled);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   // Record-Safe (Phase 3.3)
                   .withNativeFunction ("setTrackRecordSafe", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           juce::String trackId = args[0].toString();
                           bool safe = (bool)args[1];
                           audioEngine.setTrackRecordSafe(trackId, safe);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getTrackRecordSafe", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           juce::String trackId = args[0].toString();
                           completion(audioEngine.getTrackRecordSafe(trackId));
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMeterLevels", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMeterLevels());
                   })
                   .withNativeFunction ("getMasterLevel", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMasterLevel());
                   })
                   .withNativeFunction ("resetMeterClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1)
                       {
                           audioEngine.resetMeterClip(args[0].toString());
                           completion(true);
                       }
                       else
                       {
                           completion(false);
                       }
                   })
                   // Master Controls
                   .withNativeFunction ("setMasterVolume", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isDouble() || args[0].isInt())) {
                           audioEngine.setMasterVolume(args[0]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMasterVolume", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMasterVolume());
                   })
                   .withNativeFunction ("setMasterPan", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isDouble() || args[0].isInt())) {
                           audioEngine.setMasterPan(args[0]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMasterPan", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMasterPan());
                   })
                   .withNativeFunction ("setMasterMono", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           audioEngine.setMasterMono(static_cast<bool>(args[0]));
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMasterMono", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMasterMono());
                   })
                   .withNativeFunction ("addMasterFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           juce::String pluginPath = args[0].toString();
                           const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                           invalidateNAMRackTopology();
                           bool success = audioEngine.addMasterFX(pluginPath);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMasterFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMasterFX());
                   })
                   .withNativeFunction ("removeMasterFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isInt() || args[0].isDouble())) {
                           const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                           invalidateNAMRackTopology();
                           completion(audioEngine.removeMasterFX((int)args[0]));
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("reorderMasterFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2
                           && (args[0].isInt() || args[0].isDouble())
                           && (args[1].isInt() || args[1].isDouble())) {
                           const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                           invalidateNAMRackTopology();
                           completion(audioEngine.reorderMasterFX((int)args[0], (int)args[1]));
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("openMasterFXEditor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isInt() || args[0].isDouble())) {
                           audioEngine.setPluginWindowOwnerComponent(this);
                           audioEngine.openMasterFXEditor((int)args[0]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("bypassMasterFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           audioEngine.bypassMasterFX((int)args[0], (bool)args[1]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   // Monitoring FX Management (Phase 2.6)
                   .withNativeFunction ("addMonitoringFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           juce::String pluginPath = args[0].toString();
                           bool success = audioEngine.addMonitoringFX(pluginPath);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getMonitoringFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getMonitoringFX());
                   })
                   .withNativeFunction ("removeMonitoringFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isInt() || args[0].isDouble())) {
                           audioEngine.removeMonitoringFX((int)args[0]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("openMonitoringFXEditor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1 && (args[0].isInt() || args[0].isDouble())) {
                           audioEngine.setPluginWindowOwnerComponent(this);
                           audioEngine.openMonitoringFXEditor((int)args[0]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("bypassMonitoringFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 2) {
                           audioEngine.bypassMonitoringFX((int)args[0], (bool)args[1]);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   // Plugin Management
                   .withNativeFunction ("scanForPlugins", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       const bool forceRescan = args.size() > 0 && static_cast<bool>(args[0]);
                       juce::Logger::writeToLog("MainComponent: scanForPlugins called from frontend"
                                                + juce::String(forceRescan ? " (deep scan)" : ""));
                       if (pluginScanRunning.exchange(true, std::memory_order_acq_rel))
                       {
                           auto* report = new juce::DynamicObject();
                           report->setProperty("success", false);
                           report->setProperty("forceRescan", forceRescan);
                           report->setProperty("pluginCount", audioEngine.getAvailablePlugins().size());
                           report->setProperty("candidateCount", 0);
                           report->setProperty("failedCount", 0);
                           report->setProperty("skippedCount", 0);
                           report->setProperty("paths", juce::Array<juce::var>());
                           report->setProperty("failures", juce::Array<juce::var>());
                           report->setProperty("skipped", juce::Array<juce::var>());
                           report->setProperty("formats", juce::Array<juce::var>());
                           report->setProperty("debugLogPath", juce::String());
                           report->setProperty("error", "A plug-in scan is already running.");
                           completion(juce::var(report));
                           return;
                       }

                       juce::Component::SafePointer<MainComponent> safeThis(this);
                       pluginScanPool.addJob([safeThis, completion, forceRescan]() mutable {
                           if (safeThis == nullptr)
                               return;

                           auto report = safeThis->audioEngine.scanForPlugins(forceRescan);
                           if (auto* reportObject = report.getDynamicObject())
                               reportObject->setProperty("completionId", juce::Uuid().toString());

                           juce::MessageManager::callAsync([safeThis, completion, report]() mutable {
                               if (safeThis == nullptr)
                                   return;

                               safeThis->pluginScanRunning.store(false, std::memory_order_release);
                               completion(report);
                               MainComponent::broadcastEventToAll("pluginCatalogChanged", report);
                           });
                       });
                   })
                   .withNativeFunction ("getPluginScanConfiguration", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getPluginScanConfiguration());
                   })
                   .withNativeFunction ("addPluginScanPath", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       completion(args.size() == 1 && args[0].isString()
                           ? audioEngine.addPluginScanPath(args[0].toString())
                           : false);
                   })
                   .withNativeFunction ("removePluginScanPath", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       completion(args.size() == 1 && args[0].isString()
                           ? audioEngine.removePluginScanPath(args[0].toString())
                           : false);
                   })
                   .withNativeFunction ("retryBlacklistedPlugin", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       completion(args.size() == 1 && args[0].isString()
                           ? audioEngine.retryBlacklistedPlugin(args[0].toString())
                           : false);
                   })
                   .withNativeFunction ("getAvailablePlugins", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getAvailablePlugins());
                   })
                   .withNativeFunction ("addTrackInputFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 2) {
                           juce::String trackId = args[0].toString();
                           juce::String pluginPath = args[1].toString();
                           bool openEditor = args.size() >= 3 ? (bool)args[2] : true;
                           const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                           invalidateNAMRackTopology();
                           bool success = audioEngine.addTrackInputFX(trackId, pluginPath, openEditor);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("addTrackFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 2) {
                           juce::String trackId = args[0].toString();
                           juce::String pluginPath = args[1].toString();
                           bool openEditor = args.size() >= 3 ? (bool)args[2] : true;
                           const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                           invalidateNAMRackTopology();
                           bool success = audioEngine.addTrackFX(trackId, pluginPath, openEditor);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("openPluginEditor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 3) {
                           juce::String trackId = args[0].toString();
                           int fxIndex = args[1];
                           bool isInputFX = args[2];
                           audioEngine.setPluginWindowOwnerComponent(this);
                           audioEngine.openPluginEditor(trackId, fxIndex, isInputFX);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("closePluginEditor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 3) {
                           juce::String trackId = args[0].toString();
                           int fxIndex = args[1];
                           bool isInputFX = args[2];
                           audioEngine.closePluginEditor(trackId, fxIndex, isInputFX);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("closeAllPluginWindows", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        audioEngine.closeAllPluginWindows();
                        completion(true);
                    })
                    // Built-in FX Preset System
                    .withNativeFunction ("getBuiltInFXPresets", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        auto pluginName = args[0].toString();
                        completion(audioEngine.getBuiltInFXPresets(pluginName));
                    })
                    .withNativeFunction ("saveBuiltInFXPreset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        auto trackId = args[0].toString();
                        auto fxIndex = static_cast<int>(args[1]);
                        auto isInputFX = static_cast<bool>(args[2]);
                        auto presetName = args[3].toString();
                        const auto chainType = args.size() >= 5
                            ? args[4].toString()
                            : (isInputFX ? juce::String("input") : juce::String("track"));
                        completion(audioEngine.saveBuiltInFXPreset(trackId, chainType, fxIndex, presetName));
                    })
                    .withNativeFunction ("loadBuiltInFXPreset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        auto trackId = args[0].toString();
                        auto fxIndex = static_cast<int>(args[1]);
                        auto isInputFX = static_cast<bool>(args[2]);
                        auto presetName = args[3].toString();
                        const auto chainType = args.size() >= 5
                            ? args[4].toString()
                            : (isInputFX ? juce::String("input") : juce::String("track"));
                        std::vector<std::pair<juce::String, juce::uint64>> namMutationRequests;
                        const auto topologyGeneration = beginNAMModelMutationRequests(
                            trackId,
                            chainType,
                            fxIndex,
                            { "pedal", "amp", "cab" },
                            namMutationRequests);

                        juce::Component::SafePointer<MainComponent> safeThis(this);
                        builtInStateMutationPool.addJob([
                            safeThis,
                            trackId,
                            chainType,
                            fxIndex,
                            presetName,
                            namMutationRequests,
                            topologyGeneration,
                            completion]() mutable {
                            if (safeThis == nullptr)
                                return;

                            bool stillCurrent = isNAMRackTopologyCurrent(topologyGeneration);
                            for (const auto& request : namMutationRequests)
                            {
                                stillCurrent = stillCurrent
                                    && safeThis->isNAMModelMutationRequestCurrent(
                                        trackId, chainType, fxIndex, request.first, request.second);
                            }
                            if (! stillCurrent)
                            {
                                juce::MessageManager::callAsync([safeThis, completion]() mutable {
                                    if (safeThis != nullptr)
                                        completion(false);
                                });
                                return;
                            }

                            const auto publicationLeaseFactory = [
                                safeThis,
                                trackId,
                                chainType,
                                fxIndex,
                                namMutationRequests,
                                topologyGeneration]()
                            {
                                return safeThis != nullptr
                                    ? safeThis->acquireNAMModelMutationPublicationLease(
                                        trackId,
                                        chainType,
                                        fxIndex,
                                        namMutationRequests,
                                        topologyGeneration)
                                    : std::shared_ptr<void>();
                            };
                            const bool applied = safeThis->audioEngine.loadBuiltInFXPreset(
                                trackId,
                                chainType,
                                fxIndex,
                                presetName,
                                publicationLeaseFactory);
                            // A successful publication lease proves this request
                            // was current at the audible swap. A request begun
                            // afterward must not retroactively turn success false.
                            const bool result = applied;
                            juce::MessageManager::callAsync([safeThis, completion, result]() mutable {
                                if (safeThis != nullptr)
                                    completion(result);
                            });
                        });
                    })
                    .withNativeFunction ("getBuiltInFXPresetData", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() != 2)
                        {
                            completion(juce::String());
                            return;
                        }
                        completion(audioEngine.getBuiltInFXPresetData(
                            args[0].toString(), args[1].toString()));
                    })
                    .withNativeFunction ("saveBuiltInFXPresetData", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() != 3)
                        {
                            completion(false);
                            return;
                        }
                        completion(audioEngine.saveBuiltInFXPresetData(
                            args[0].toString(), args[1].toString(), args[2].toString()));
                    })
                    .withNativeFunction ("copyBuiltInFXPreset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() != 3)
                        {
                            completion(false);
                            return;
                        }
                        const auto pluginName = args[0].toString();
                        const auto sourcePresetName = args[1].toString();
                        const auto targetPresetName = args[2].toString();
                        completion(audioEngine.copyBuiltInFXPreset(pluginName, sourcePresetName, targetPresetName));
                    })
                    .withNativeFunction ("deleteBuiltInFXPreset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        auto pluginName = args[0].toString();
                        auto presetName = args[1].toString();
                        completion(audioEngine.deleteBuiltInFXPreset(pluginName, presetName));
                    })
                    // FX Chain Query and Management
                    .withNativeFunction ("getTrackInputFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            juce::String trackId = args[0].toString();
                            completion(audioEngine.getTrackInputFX(trackId));
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("getTrackFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            juce::String trackId = args[0].toString();
                            completion(audioEngine.getTrackFX(trackId));
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("getPluginParameters", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[0].isString()) {
                            juce::String trackId = args[0].toString();
                            int fxIndex = static_cast<int>(args[1]);
                            bool isInputFX = static_cast<bool>(args[2]);
                            completion(audioEngine.getPluginParameters(trackId, fxIndex, isInputFX));
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("getBuiltInPluginSchema", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3 && args[0].isString()) {
                            completion(audioEngine.getBuiltInPluginSchema(args[0].toString(), args[1].toString(), static_cast<int>(args[2])));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("getNAMRackDiagnostics", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3 && args[0].isString()) {
                            completion(audioEngine.getNAMRackDiagnostics(args[0].toString(), args[1].toString(), static_cast<int>(args[2])));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("getBuiltInPluginState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3 && args[0].isString()) {
                            completion(audioEngine.getBuiltInPluginState(args[0].toString(), args[1].toString(), static_cast<int>(args[2])));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("setBuiltInPluginParam", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 5 && args[0].isString()) {
                            completion(audioEngine.setBuiltInPluginParam(args[0].toString(), args[1].toString(), static_cast<int>(args[2]),
                                                                         args[3].toString(), static_cast<float>(static_cast<double>(args[4]))));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setBuiltInPluginState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4 && args[0].isString()) {
                            const auto trackId = args[0].toString();
                            const auto chainType = args[1].toString();
                            const int fxIndex = static_cast<int>(args[2]);
                            const auto stateJson = args[3].toString();
                            const auto namMutationSlots = getNAMModelMutationSlots(stateJson);
                            std::vector<std::pair<juce::String, juce::uint64>> namMutationRequests;
                            const auto topologyGeneration = beginNAMModelMutationRequests(
                                trackId, chainType, fxIndex, namMutationSlots, namMutationRequests);

                            juce::Component::SafePointer<MainComponent> safeThis(this);
                            builtInStateMutationPool.addJob([safeThis, trackId, chainType, fxIndex, stateJson, namMutationRequests, topologyGeneration, completion]() mutable {
                                if (safeThis == nullptr)
                                    return;

                                if (! isNAMRackTopologyCurrent(topologyGeneration))
                                {
                                    juce::Logger::writeToLog(
                                        "Built-in bridge: skipped state mutation after FX topology changed");
                                    juce::MessageManager::callAsync([safeThis, completion]() mutable {
                                        if (safeThis != nullptr)
                                            completion(false);
                                    });
                                    return;
                                }

                                for (const auto& request : namMutationRequests)
                                {
                                    if (! safeThis->isNAMModelMutationRequestCurrent(
                                            trackId, chainType, fxIndex, request.first, request.second))
                                    {
                                        juce::Logger::writeToLog(
                                            "Built-in bridge: skipped superseded NAM-bearing state mutation slot="
                                            + request.first);
                                        juce::MessageManager::callAsync([safeThis, completion]() mutable {
                                            if (safeThis != nullptr)
                                                completion(false);
                                        });
                                        return;
                                    }
                                }

                                juce::Logger::writeToLog("Built-in bridge: sequenced state mutation started chain=" + chainType + " fx=" + juce::String(fxIndex));
                                const auto publicationLeaseFactory = [safeThis,
                                                               trackId,
                                                               chainType,
                                                               fxIndex,
                                                               namMutationRequests,
                                                               topologyGeneration]()
                                {
                                    return safeThis != nullptr
                                        ? safeThis->acquireNAMModelMutationPublicationLease(
                                            trackId, chainType, fxIndex,
                                            namMutationRequests, topologyGeneration)
                                        : std::shared_ptr<void>();
                                };
                                const bool applied = safeThis->audioEngine.setBuiltInPluginState(
                                    trackId, chainType, fxIndex, stateJson, publicationLeaseFactory);
                                const bool result = applied;
                                juce::Logger::writeToLog("Built-in bridge: sequenced state mutation finished chain=" + chainType + " fx=" + juce::String(fxIndex) + " result=" + juce::String(result ? "true" : "false"));
                                juce::MessageManager::callAsync([safeThis, completion, result]() mutable {
                                    if (safeThis != nullptr)
                                        completion(result);
                                });
                            });
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setPluginParameter", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 5 && args[0].isString()) {
                            juce::String trackId = args[0].toString();
                            int fxIndex = static_cast<int>(args[1]);
                            bool isInputFX = static_cast<bool>(args[2]);
                            int paramIndex = static_cast<int>(args[3]);
                            float value = static_cast<float>(static_cast<double>(args[4]));
                            completion(audioEngine.setPluginParameter(trackId, fxIndex, isInputFX, paramIndex, value));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("removeTrackInputFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[1].isInt()) {
                           juce::String trackId = args[0].toString();
                           const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                           invalidateNAMRackTopology();
                           completion(audioEngine.removeTrackInputFX(trackId, args[1]));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("removeTrackFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[1].isInt()) {
                           juce::String trackId = args[0].toString();
                           const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                           invalidateNAMRackTopology();
                           completion(audioEngine.removeTrackFX(trackId, args[1]));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("bypassTrackInputFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[1].isInt() && args[2].isBool()) {
                            juce::String trackId = args[0].toString();
                            audioEngine.bypassTrackInputFX(trackId, args[1], args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("bypassTrackFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[1].isInt() && args[2].isBool()) {
                            juce::String trackId = args[0].toString();
                            audioEngine.bypassTrackFX(trackId, args[1], args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("reorderTrackInputFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[1].isInt() && args[2].isInt()) {
                            juce::String trackId = args[0].toString();
                            int fromIndex = args[1];
                            int toIndex = args[2];
                            const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                            invalidateNAMRackTopology();
                            bool success = audioEngine.reorderTrackInputFX(trackId, fromIndex, toIndex);
                            completion(success);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("reorderTrackFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[1].isInt() && args[2].isInt()) {
                            juce::String trackId = args[0].toString();
                            int fromIndex = args[1];
                            int toIndex = args[2];
                            const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                            invalidateNAMRackTopology();
                            bool success = audioEngine.reorderTrackFX(trackId, fromIndex, toIndex);
                            completion(success);
                        } else {
                            completion(false);
                        }
                    })
                   // S13FX (JSFX) Management
                   .withNativeFunction ("addTrackS13FX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 2) {
                           juce::String trackId = args[0].toString();
                           juce::String scriptPath = args[1].toString();
                           bool isInputFX = args.size() >= 3 ? (bool)args[2] : false;
                           const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                           invalidateNAMRackTopology();
                           bool success = audioEngine.addTrackS13FX(trackId, scriptPath, isInputFX);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("addMasterS13FX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 1) {
                           juce::String scriptPath = args[0].toString();
                           const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                           invalidateNAMRackTopology();
                           bool success = audioEngine.addMasterS13FX(scriptPath);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getS13FXSliders", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 3) {
                           juce::String trackId = args[0].toString();
                           int fxIndex = args[1];
                           bool isInputFX = args[2];
                           completion(audioEngine.getS13FXSliders(trackId, fxIndex, isInputFX));
                       } else {
                           completion(juce::Array<juce::var>());
                       }
                   })
                   .withNativeFunction ("setS13FXSlider", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 5) {
                           juce::String trackId = args[0].toString();
                           int fxIndex = args[1];
                           bool isInputFX = args[2];
                           int sliderIndex = args[3];
                           double value = args[4];
                           bool success = audioEngine.setS13FXSlider(trackId, fxIndex, isInputFX, sliderIndex, value);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("reloadS13FX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 3) {
                           juce::String trackId = args[0].toString();
                           int fxIndex = args[1];
                           bool isInputFX = args[2];
                           bool success = audioEngine.reloadS13FX(trackId, fxIndex, isInputFX);
                           completion(success);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getAvailableS13FX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getAvailableS13FX());
                   })
                   .withNativeFunction ("openUserEffectsFolder", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       auto userDir = PluginManager::getUserEffectsDirectory();
                       userDir.createDirectory();
                       userDir.revealToUser();
                       completion(true);
                   })
                   // Lua Scripting (S13Script)
                   .withNativeFunction ("runScript", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 1) {
                           juce::String scriptPath = args[0].toString();
                           completion(audioEngine.runScript(scriptPath));
                       } else {
                           auto* err = new juce::DynamicObject();
                           err->setProperty("success", false);
                           err->setProperty("error", "Missing scriptPath argument");
                           err->setProperty("output", "");
                           completion(juce::var(err));
                       }
                   })
                   .withNativeFunction ("runScriptCode", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 1) {
                           juce::String code = args[0].toString();
                           completion(audioEngine.runScriptCode(code));
                       } else {
                           auto* err = new juce::DynamicObject();
                           err->setProperty("success", false);
                           err->setProperty("error", "Missing code argument");
                           err->setProperty("output", "");
                           completion(juce::var(err));
                       }
                   })
                   .withNativeFunction ("getScriptDirectory", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getScriptDirectory());
                   })
                   .withNativeFunction ("listScripts", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.listScripts());
                   })
                   // Transport Position
                   .withNativeFunction ("getTransportPosition", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getTransportPosition());
                   })
                   .withNativeFunction ("setTransportPosition", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           double seconds = args[0];
                           OPENSTUDIO_LOG_AUDIO_BRIDGE("setTransportPosition seconds=" + juce::String(seconds, 3));
                           audioEngine.setTransportPosition(seconds);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   // Tempo Control
                   .withNativeFunction ("setTempo", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() == 1) {
                           double bpm = args[0];
                           audioEngine.setTempo(bpm);
                           completion(true);
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getTempo", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       juce::ignoreUnused(args);
                       completion(audioEngine.getTempo());
                   })
                    // Metronome & Time Signature (Phase 3)
                    .withNativeFunction ("setMetronomeEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isBool()) {
                            audioEngine.setMetronomeEnabled(args[0]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setMetronomeVolume", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && (args[0].isDouble() || args[0].isInt())) {
                            audioEngine.setMetronomeVolume(args[0]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("isMetronomeEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.isMetronomeEnabled());
                    })
                    .withNativeFunction ("setMetronomeAccentBeats", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                         if (args.size() == 1 && args[0].isArray()) {
                             auto* arr = args[0].getArray();
                             std::vector<bool> accents;
                             for (const auto& item : *arr) {
                                 accents.push_back(item);
                             }
                             audioEngine.setMetronomeAccentBeats(accents);
                             completion(true);
                         } else {
                             completion(false);
                         }
                    })
                    .withNativeFunction ("renderMetronomeToFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && (args[0].isDouble() || args[0].isInt()) && (args[1].isDouble() || args[1].isInt())) {
                            double startTime = (double)args[0];
                            double endTime = (double)args[1];
                            juce::String filePath = audioEngine.renderMetronomeToFile(startTime, endTime);
                            completion(filePath);
                        } else {
                            completion(juce::String(""));
                        }
                    })
                    .withNativeFunction ("setTimeSignature", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isInt() && args[1].isInt()) {
                            audioEngine.setTimeSignature(args[0], args[1]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getTimeSignature", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        juce::DynamicObject* result = new juce::DynamicObject();
                        int num, den;
                        audioEngine.getTimeSignature(num, den);
                        result->setProperty("numerator", num);
                        result->setProperty("denominator", den);
                        completion(result);
                    })
                    // Recording
                   .withNativeFunction ("getLastCompletedClips", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        OPENSTUDIO_LOG_AUDIO_BRIDGE("getLastCompletedClips");
                        auto clips = audioEngine.getLastCompletedClips();
                        juce::Array<juce::var> clipArray;
                        
                        for (const auto& clip : clips)
                        {
                            juce::DynamicObject* clipObj = new juce::DynamicObject();
                            clipObj->setProperty("trackId", clip.trackId);
                            clipObj->setProperty("filePath", clip.file.getFullPathName());
                            clipObj->setProperty("startTime", clip.startTime);
                            clipObj->setProperty("duration", clip.duration);
                            clipArray.add(clipObj);
                        }
                        
                        completion(clipArray);
                    })
                    .withNativeFunction ("getLastCompletedMIDIClips", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        auto clips = audioEngine.getLastCompletedMIDIClips();
                        juce::Array<juce::var> clipArray;

                        for (const auto& clip : clips)
                        {
                            juce::DynamicObject* clipObj = new juce::DynamicObject();
                            clipObj->setProperty("trackId", clip.trackId);
                            clipObj->setProperty("startTime", clip.startTime);
                            clipObj->setProperty("duration", clip.duration);
                            if (clip.midiFile.existsAsFile())
                                clipObj->setProperty("filePath", clip.midiFile.getFullPathName());

                            // Serialize MIDI events as JSON array
                            juce::Array<juce::var> eventsArray;
                            for (const auto& evt : clip.events)
                            {
                                juce::DynamicObject* evtObj = new juce::DynamicObject();
                                evtObj->setProperty("timestamp", evt.timestamp);

                                if (evt.message.isNoteOn())
                                {
                                    evtObj->setProperty("type", "noteOn");
                                    evtObj->setProperty("note", evt.message.getNoteNumber());
                                    evtObj->setProperty("velocity", evt.message.getVelocity());
                                    evtObj->setProperty("channel", evt.message.getChannel());
                                }
                                else if (evt.message.isNoteOff())
                                {
                                    evtObj->setProperty("type", "noteOff");
                                    evtObj->setProperty("note", evt.message.getNoteNumber());
                                    evtObj->setProperty("velocity", 0);
                                    evtObj->setProperty("channel", evt.message.getChannel());
                                }
                                else if (evt.message.isController())
                                {
                                    evtObj->setProperty("type", "cc");
                                    evtObj->setProperty("controller", evt.message.getControllerNumber());
                                    evtObj->setProperty("value", evt.message.getControllerValue());
                                    evtObj->setProperty("channel", evt.message.getChannel());
                                }
                                else if (evt.message.isPitchWheel())
                                {
                                    evtObj->setProperty("type", "pitchBend");
                                    evtObj->setProperty("value", evt.message.getPitchWheelValue());
                                    evtObj->setProperty("channel", evt.message.getChannel());
                                }
                                else
                                {
                                    continue;  // Skip unsupported event types
                                }

                                eventsArray.add(evtObj);
                            }
                            clipObj->setProperty("events", eventsArray);

                            clipArray.add(clipObj);
                        }

                        completion(clipArray);
                    })
                   // Waveform Visualization
                   .withNativeFunction ("getWaveformPeaks", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       // args: [filePath, samplesPerPixel, startSample, numPixels]
                       // Legacy 3-arg form also accepted (startSample=0)
                       if (args.size() >= 3) {
                           juce::String filePath = args[0].toString();
                           int samplesPerPixel = args[1];
                           int startSample = (args.size() >= 4) ? static_cast<int>(args[2]) : 0;
                           int numPixels = (args.size() >= 4) ? static_cast<int>(args[3]) : static_cast<int>(args[2]);
                           completion(audioEngine.getWaveformPeaks(filePath, samplesPerPixel, startSample, numPixels));
                       } else {
                           completion(juce::Array<juce::var>());
                       }
                   })
                   .withNativeFunction ("getAudioPeakAmplitude", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() != 3
                           || ! args[0].isString()
                           || (! args[1].isDouble() && ! args[1].isInt())
                           || (! args[2].isDouble() && ! args[2].isInt()))
                       {
                           completion(-1.0);
                           return;
                       }

                       const juce::String filePath = args[0].toString();
                       const double offsetSeconds = static_cast<double>(args[1]);
                       const double durationSeconds = static_cast<double>(args[2]);
                       juce::Component::SafePointer<MainComponent> safeThis(this);
                       clipPeakAnalysisPool.addJob([
                           safeThis,
                           filePath,
                           offsetSeconds,
                           durationSeconds,
                           completion]() mutable {
                           if (safeThis == nullptr)
                               return;
                           const double peak = safeThis->audioEngine.getAudioPeakAmplitude(
                               filePath,
                               offsetSeconds,
                               durationSeconds);
                           juce::MessageManager::callAsync([safeThis, completion, peak]() mutable {
                               if (safeThis != nullptr)
                                   completion(peak);
                           });
                       });
                   })
                   .withNativeFunction ("refreshWaveformPeaks", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 1) {
                           completion(audioEngine.refreshWaveformPeaks(args[0].toString()));
                       } else {
                           completion(false);
                       }
                   })
                   .withNativeFunction ("getRecordingPeaks", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                       if (args.size() >= 3) {
                           juce::String trackId = args[0].toString();
                           int samplesPerPixel = args[1];
                           int numPixels = args[2];
                           juce::int64 startSample = args.size() >= 4
                               ? static_cast<juce::int64>(static_cast<double>(args[3]))
                               : 0;
                           OPENSTUDIO_LOG_AUDIO_BRIDGE("getRecordingPeaks track=" + trackId
                               + " samplesPerPixel=" + juce::String(samplesPerPixel)
                               + " numPixels=" + juce::String(numPixels)
                               + " startSample=" + juce::String(startSample));
                           completion(audioEngine.getRecordingPeaks(
                               trackId, samplesPerPixel, numPixels, startSample));
                       } else {
                           completion(juce::Array<juce::var>());
                       }
                   })
                   // Playback clip management
                   .withNativeFunction ("addPlaybackClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Accepts 4-11 args: trackId, filePath, startTime, duration, [offset], [volumeDB], [fadeIn], [fadeOut], [clipId], [pitchCorrectionSourceFilePath], [pitchCorrectionSourceOffset]
                        // Note: numeric args can be int or double depending on JS value serialization
                        if (args.size() >= 4 && args[1].isString()) {
                            juce::String trackId = args[0].toString();
                            juce::String filePath = args[1].toString();
                            double startTime = (double)args[2];
                            double duration = (double)args[3];
                            double offset = args.size() > 4 ? (double)args[4] : 0.0;
                            double volumeDB = args.size() > 5 ? (double)args[5] : 0.0;
                            double fadeIn = args.size() > 6 ? (double)args[6] : 0.0;
                            double fadeOut = args.size() > 7 ? (double)args[7] : 0.0;
                            juce::String clipId = args.size() > 8 ? args[8].toString() : juce::String();
                            juce::String pitchCorrectionSourceFilePath = args.size() > 9 ? args[9].toString() : juce::String();
                            double pitchCorrectionSourceOffset = args.size() > 10 ? (double)args[10] : -1.0;
                            OPENSTUDIO_LOG_AUDIO_BRIDGE("addPlaybackClip track=" + trackId
                                + " clipId=" + clipId
                                + " file=" + filePath
                                + " start=" + juce::String(startTime, 3)
                                + " duration=" + juce::String(duration, 3));
                            audioEngine.addPlaybackClip(trackId, filePath, startTime, duration, offset, volumeDB, fadeIn, fadeOut, clipId,
                                                        pitchCorrectionSourceFilePath, pitchCorrectionSourceOffset);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                   .withNativeFunction ("removePlaybackClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[1].isString()) {
                            juce::String trackId = args[0].toString();
                            juce::String filePath = args[1].toString();
                            audioEngine.removePlaybackClip(trackId, filePath);
                            completion(true);
                        } else {
                            completion(false);
                         }
                     })
                   .withNativeFunction ("removePlaybackClipById", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[1].isString()) {
                            juce::String trackId = args[0].toString();
                            juce::String clipId = args[1].toString();
                            audioEngine.removePlaybackClipById(trackId, clipId);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                   .withNativeFunction ("addPlaybackClipsBatch", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString())
                        {
                            OPENSTUDIO_LOG_AUDIO_BRIDGE("addPlaybackClipsBatch");
                            audioEngine.addPlaybackClipsBatch (args[0].toString());
                            completion (true);
                        }
                        else
                            completion (false);
                    })
                   .withNativeFunction ("clearPlaybackClips", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        OPENSTUDIO_LOG_AUDIO_BRIDGE("clearPlaybackClips");
                        audioEngine.clearPlaybackClips();
                        completion(true);
                    })
                    // MIDI Device Management (Phase 2)
                    .withNativeFunction ("getMIDIInputDevices", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getMIDIInputDevices());
                    })
                    .withNativeFunction ("getMIDIOutputDevices", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getMIDIOutputDevices());
                    })
                    .withNativeFunction ("openMIDIDevice", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String deviceName = args[0].toString();
                            completion(audioEngine.openMIDIDevice(deviceName));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("closeMIDIDevice", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String deviceName = args[0].toString();
                            audioEngine.closeMIDIDevice(deviceName);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getOpenMIDIDevices", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getOpenMIDIDevices());
                    })
                    // Track Type Management (Phase 2)
                    .withNativeFunction ("setTrackType", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isString() && args[1].isString()) {
                            juce::String trackId = args[0].toString();
                            juce::String type = args[1].toString();
                            audioEngine.setTrackType(trackId, type);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackMIDIInput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[0].isString() && args[1].isString() && args[2].isInt()) {
                            juce::String trackId = args[0].toString();
                            juce::String deviceName = args[1].toString();
                            int channel = args[2];
                            audioEngine.setTrackMIDIInput(trackId, deviceName, channel);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackMIDIClips", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isString() && args[1].isString()) {
                            audioEngine.setTrackMIDIClips(args[0].toString(), args[1].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("loadInstrument", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isString() && args[1].isString()) {
                            juce::String trackId = args[0].toString();
                            juce::String vstPath = args[1].toString();
                            completion(audioEngine.loadInstrument(trackId, vstPath));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("openInstrumentEditor", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String trackId = args[0].toString();
                            audioEngine.setPluginWindowOwnerComponent(this);
                            audioEngine.openInstrumentEditor(trackId);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("removeInstrument", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isString()) {
                            completion(audioEngine.removeInstrument(args[0].toString()));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackSamplerSample", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3 && args[0].isString() && args[1].isString()) {
                            completion(audioEngine.setTrackSamplerSample(args[0].toString(),
                                                                         args[1].toString(),
                                                                         static_cast<int>(args[2])));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("clearTrackSamplerSample", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isString()) {
                            completion(audioEngine.clearTrackSamplerSample(args[0].toString()));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getInstrumentState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isString()) {
                            completion(audioEngine.getInstrumentState(args[0].toString()));
                        } else {
                            completion(juce::String());
                        }
                    })
                    .withNativeFunction ("setInstrumentState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isString() && args[1].isString()) {
                            completion(audioEngine.setInstrumentState(args[0].toString(), args[1].toString()));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("sendMidiNote", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 4 && args[0].isString()) {
                            completion(audioEngine.sendMidiNote(args[0].toString(),
                                                                static_cast<int>(args[1]),
                                                                static_cast<int>(args[2]),
                                                                static_cast<bool>(args[3])));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getTrackMIDINoteActivity", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString()) {
                            const int maxAgeMs = args.size() >= 2 ? static_cast<int>(args[1]) : 1200;
                            completion(audioEngine.getTrackMIDINoteActivity(args[0].toString(), maxAgeMs));
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("panicMIDI", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.panicMIDI());
                    })
                    .withNativeFunction ("getActiveRecordingMIDIPreviews", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getActiveRecordingMIDIPreviews(args[0]));
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("getMidiDiagnostics", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getMidiDiagnostics());
                    })
                    .withNativeFunction ("getAudioDebugSnapshot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getAudioDebugSnapshot());
                    })
                    .withNativeFunction ("getRealtimeAudioTelemetry", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getRealtimeAudioTelemetry());
                    })
                    .withNativeFunction ("getPluginCapabilities", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isString()) {
                            completion(audioEngine.getPluginCapabilities(args[0].toString()));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("setProcessingPrecision", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1 && args[0].isString()) {
                            audioEngine.setProcessingPrecision(args[0].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getProcessingPrecision", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getProcessingPrecision());
                    })
                    .withNativeFunction ("getPluginCompatibilityMatrix", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getPluginCompatibilityMatrix());
                    })
                    .withNativeFunction ("runEngineBenchmarks", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.runEngineBenchmarks());
                    })
                    .withNativeFunction ("setTrackPluginPrecisionOverride", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 4 && args[0].isString() && args[1].isInt() && args[2].isBool() && args[3].isString()) {
                            completion(audioEngine.setTrackPluginPrecisionOverride(args[0].toString(),
                                                                                 static_cast<int>(args[1]),
                                                                                 static_cast<bool>(args[2]),
                                                                                 args[3].toString()));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setInstrumentPrecisionOverride", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isString() && args[1].isString()) {
                            completion(audioEngine.setInstrumentPrecisionOverride(args[0].toString(), args[1].toString()));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setMasterFXPrecisionOverride", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isInt() && args[1].isString()) {
                            completion(audioEngine.setMasterFXPrecisionOverride(static_cast<int>(args[0]), args[1].toString()));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setMonitoringFXPrecisionOverride", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isInt() && args[1].isString()) {
                            completion(audioEngine.setMonitoringFXPrecisionOverride(static_cast<int>(args[0]), args[1].toString()));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("runReleaseGuardrails", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.runReleaseGuardrails());
                    })
                    .withNativeFunction ("runAutomatedRegressionSuite", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.runAutomatedRegressionSuite());
                    })
                    .withNativeFunction ("getAppVersion", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(appUpdater.getCurrentVersion());
                    })
                    .withNativeFunction ("checkForUpdates", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        bool manual = true;
                        if (args.size() > 0)
                            manual = static_cast<bool>(args[0]);

                        appUpdater.checkForUpdates(manual, [completion](const juce::var& status)
                        {
                            completion(status);
                        });
                    })
                    .withNativeFunction ("downloadAndInstallUpdate", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto downloadUrl = args.size() > 0 ? args[0].toString() : juce::String();
                        const auto version = args.size() > 1 ? args[1].toString() : juce::String();
                        const auto expectedSha256 = args.size() > 2 ? args[2].toString() : juce::String();
                        const auto releasePageUrl = args.size() > 3 ? args[3].toString() : juce::String();
                        const auto installerArguments = args.size() > 4 ? args[4].toString() : juce::String();
                        const auto expectedSize = args.size() > 5 ? static_cast<juce::int64>(args[5]) : 0;

                        appUpdater.downloadAndInstallUpdate(downloadUrl, version, expectedSha256, releasePageUrl, installerArguments, expectedSize, [completion](const juce::var& status)
                        {
                            completion(status);
                        });
                    })
                    .withNativeFunction ("openExternalURL", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 0 || ! args[0].isString())
                        {
                            completion(false);
                            return;
                        }

                        const auto url = args[0].toString().trim();
                        if (! isAllowedExternalBrowserURL(url))
                        {
                            completion(false);
                            return;
                        }

                        completion(juce::URL(url).launchInDefaultBrowser());
                    })
                    .withNativeFunction ("revealLocalPath", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 0 || ! args[0].isString())
                        {
                            completion(false);
                            return;
                        }

                        const auto path = args[0].toString();
                        if (path.trim().isEmpty()
                            || path.containsAnyOf("\r\n")
                            || ! juce::File::isAbsolutePath(path))
                        {
                            completion(false);
                            return;
                        }

                        const juce::File localPath(path);
                        if (! localPath.existsAsFile() && ! localPath.isDirectory())
                        {
                            completion(false);
                            return;
                        }

                        // revealToUser opens the containing file manager and never
                        // executes the selected file.
                        localPath.revealToUser();
                        completion(true);
                    })
                    .withNativeFunction ("createTONE3000AuthRequest", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto clientId = args.size() > 0 ? args[0].toString() : juce::String();
                        const auto redirectUri = args.size() > 1 ? args[1].toString() : juce::String();
                        const auto prompt = args.size() > 2 ? args[2].toString() : juce::String();
                        const auto toneId = args.size() > 3 ? args[3].toString() : juce::String();
                        const auto loginHint = args.size() > 4 ? args[4].toString() : juce::String();
                        completion(createTone3000AuthRequest(clientId, redirectUri, prompt, toneId, loginHint));
                    })
                    .withNativeFunction ("startTONE3000AuthFlow", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto options = args.size() > 0 ? args[0] : juce::var();
                        std::thread([options, completion]() mutable {
                            auto result = startTone3000AuthFlow(options);
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("cancelTONE3000AuthFlow", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(cancelTone3000AuthFlow());
                    })
                    .withNativeFunction ("exchangeTONE3000OAuthCode", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto code = args.size() > 0 ? args[0].toString() : juce::String();
                        const auto state = args.size() > 1 ? args[1].toString() : juce::String();
                        const auto clientId = args.size() > 2 ? args[2].toString() : juce::String();
                        const auto redirectUri = args.size() > 3 ? args[3].toString() : juce::String();
                        std::thread([code, state, clientId, redirectUri, completion]() mutable {
                            juce::Logger::writeToLog("TONE3000 bridge: exchangeOAuthCode started");
                            auto result = exchangeTone3000OAuthCode(code, state, clientId, redirectUri);
                            juce::Logger::writeToLog("TONE3000 bridge: exchangeOAuthCode finished");
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("refreshTONE3000Auth", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto clientId = args.size() > 0 ? args[0].toString() : juce::String();
                        std::thread([clientId, completion]() mutable {
                            juce::Logger::writeToLog("TONE3000 bridge: refreshAuth started");
                            auto result = refreshTone3000Auth(clientId);
                            juce::Logger::writeToLog("TONE3000 bridge: refreshAuth finished");
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("getTONE3000AuthStatus", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(makeTone3000AuthStatus());
                    })
                    .withNativeFunction ("clearTONE3000Auth", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        tone3000AuthFlowGeneration.fetch_add(1);
                        getTone3000TokenFile().deleteFile();
                        getTone3000PendingAuthFile().deleteFile();
                        juce::DynamicObject::Ptr result = new juce::DynamicObject();
                        result->setProperty("success", true);
                        result->setProperty("authenticated", false);
                        completion(juce::var(result.get()));
                    })
                    .withNativeFunction ("getNAMLibraryInfo", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(makeNAMLibraryInfo());
                    })
                    .withNativeFunction ("inspectNAMAsset", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto filePath = args.size() > 0 ? args[0].toString() : juce::String();
                        std::thread([filePath, completion]() mutable {
                           #if JUCE_WINDOWS
                            ::SetThreadPriority(
                                ::GetCurrentThread(),
                                THREAD_PRIORITY_BELOW_NORMAL);
                           #endif
                            const auto result = inspectNAMAssetFile(filePath);
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("findNAMAssetInDirectory", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto directoryPath = args.size() > 0 ? args[0].toString() : juce::String();
                        const auto expectedFileName = args.size() > 1 ? args[1].toString() : juce::String();
                        const auto checksum = args.size() > 2 ? args[2].toString() : juce::String();
                        const auto fileSizeBytes = args.size() > 3 ? static_cast<juce::int64>(static_cast<double>(args[3])) : 0;
                        const auto slot = args.size() > 4 ? args[4].toString().trim().toLowerCase() : juce::String("amp");
                        std::thread([directoryPath, expectedFileName, checksum, fileSizeBytes, slot, completion]() mutable {
                            const auto result = findNAMAssetInDirectory(directoryPath, expectedFileName, checksum, fileSizeBytes, slot);
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("getNAMCatalog", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(parseJsonFileOrDefault(getOpenStudioNAMCatalogJson(), "tones"));
                    })
                    .withNativeFunction ("refreshNAMCatalog", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto options = args.size() > 0 ? args[0] : juce::var();
                        std::thread([options, completion]() mutable {
                            auto result = refreshNAMCatalogFromUpdater(options);
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("searchTONE3000NAM", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto options = args.size() > 0 ? args[0] : juce::var();
                        std::thread([options, completion]() mutable {
                            juce::Logger::writeToLog("TONE3000 bridge: searchNAM started");
                            auto result = searchTone3000NAM(options);
                            juce::Logger::writeToLog("TONE3000 bridge: searchNAM finished");
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("runTONE3000AuthenticatedQA", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        std::thread([completion]() mutable {
                            const auto result = runTone3000AuthenticatedQA();
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("getTONE3000ToneDetail", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const int toneId = args.size() > 0 ? static_cast<int>(args[0]) : 0;
                        const auto architecture = args.size() > 1 ? args[1].toString() : juce::String();
                        std::thread([toneId, architecture, completion]() mutable {
                            juce::Logger::writeToLog("TONE3000 bridge: toneDetail started toneId=" + juce::String(toneId));
                            auto result = getTone3000ToneDetail(toneId, architecture);
                            juce::Logger::writeToLog("TONE3000 bridge: toneDetail finished toneId=" + juce::String(toneId));
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("getNAMLibrary", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        std::thread([completion]() mutable {
                            juce::Logger::writeToLog("TONE3000 bridge: getNAMLibrary started");
                            auto result = refreshNAMLibraryManifest(true);
                            juce::Logger::writeToLog("TONE3000 bridge: getNAMLibrary finished");
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("installNAMModel", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() < 1)
                        {
                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("success", false);
                            result->setProperty("error", "Missing NAM model metadata");
                            completion(juce::var(result.get()));
                            return;
                        }
                        const auto modelPayload = args[0];
                        const auto optionsPayload = args.size() > 1 ? args[1] : juce::var();
                        std::thread([modelPayload, optionsPayload, completion]() mutable {
                            bool previewMode = false;
                            if (optionsPayload.isString())
                            {
                                const auto options = juce::JSON::parse(optionsPayload.toString());
                                if (auto* object = options.getDynamicObject())
                                    previewMode = object->getProperty("mode").toString() == "preview";
                            }
                            else if (auto* object = optionsPayload.getDynamicObject())
                            {
                                previewMode = object->getProperty("mode").toString() == "preview";
                            }

                            juce::Logger::writeToLog("TONE3000 bridge: installNAMModel started mode=" + juce::String(previewMode ? "preview" : "library"));
                            auto result = installNAMModelFromMetadata(modelPayload, previewMode);
                            juce::Logger::writeToLog("TONE3000 bridge: installNAMModel finished");
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("commitNAMPreviewTone", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto recordPayload = args.size() > 0 ? args[0] : juce::var();
                        const auto metadataPayload = args.size() > 1 ? args[1] : juce::var();
                        const auto rackStatePayload = args.size() > 2 ? args[2] : juce::var();
                        std::thread([recordPayload, metadataPayload, rackStatePayload, completion]() mutable {
                            juce::Logger::writeToLog("TONE3000 bridge: commitNAMPreviewTone started");
                            auto result = commitNAMPreviewToneToLibrary(recordPayload, metadataPayload, rackStatePayload);
                            juce::Logger::writeToLog("TONE3000 bridge: commitNAMPreviewTone finished");
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("discardNAMPreview", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto recordPayload = args.size() > 0 ? args[0] : juce::var();
                        const auto rackAddressPayload = args.size() > 1 ? args[1] : juce::var();
                        juce::Component::SafePointer<MainComponent> safeThis(this);
                        builtInStateMutationPool.addJob([safeThis, recordPayload, rackAddressPayload, completion]() mutable {
                            if (safeThis == nullptr)
                                return;

                            auto result = safeThis->discardNAMPreviewIfUnused(recordPayload, rackAddressPayload);
                            juce::MessageManager::callAsync([safeThis, completion, result]() {
                                if (safeThis != nullptr)
                                    completion(result);
                            });
                        });
                    })
                    .withNativeFunction ("cleanupNAMPreviews", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const double maxAgeHours = args.size() > 0 ? static_cast<double>(args[0]) : 24.0;
                        std::thread([maxAgeHours, completion]() mutable {
                            auto result = cleanupNAMPreviewFiles(maxAgeHours);
                            juce::MessageManager::callAsync([completion, result]() {
                                completion(result);
                            });
                        }).detach();
                    })
                    .withNativeFunction ("setNAMModelFavorite", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const int modelId = args.size() > 0 ? static_cast<int>(args[0]) : 0;
                        const auto localPath = args.size() > 1 ? args[1].toString() : juce::String();
                        const bool favorite = args.size() > 2 && static_cast<bool>(args[2]);
                        completion(setNAMLibraryFavorite(modelId, localPath, favorite));
                    })
                    .withNativeFunction ("removeNAMModel", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const int modelId = args.size() > 0 ? static_cast<int>(args[0]) : 0;
                        const auto localPath = args.size() > 1 ? args[1].toString() : juce::String();
                        const bool deleteLocalFile = args.size() > 2 && static_cast<bool>(args[2]);
                        completion(removeNAMModelFromLibrary(modelId, localPath, deleteLocalFile));
                    })
                    .withNativeFunction ("loadNAMModelIntoRack", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() < 5)
                        {
                            completion(false);
                            return;
                        }

                        const auto trackId = args[0].toString();
                        const auto chainType = args[1].toString();
                        const int fxIndex = static_cast<int>(args[2]);
                        const auto slot = args[3].toString().trim().toLowerCase();
                        const auto localPath = args[4].toString();
                        if (slot != "pedal" && slot != "amp" && slot != "cab")
                        {
                            completion(false);
                            return;
                        }

                        juce::StringArray mutationSlots;
                        mutationSlots.add(slot);
                        std::vector<std::pair<juce::String, juce::uint64>> mutationRequests;
                        const auto topologyGeneration = beginNAMModelMutationRequests(
                            trackId, chainType, fxIndex, mutationSlots, mutationRequests);
                        const auto requestGeneration = mutationRequests.front().second;
                        juce::Component::SafePointer<MainComponent> safeThis(this);
                        builtInStateMutationPool.addJob([safeThis, trackId, chainType, fxIndex, slot, localPath, requestGeneration, topologyGeneration, completion]() mutable {
                            if (safeThis == nullptr)
                                return;

                            const auto completeSafely = [safeThis, completion](bool result) {
                                juce::MessageManager::callAsync([safeThis, completion, result]() {
                                    if (safeThis != nullptr)
                                        completion(result);
                                });
                            };

                            if (! isNAMRackTopologyCurrent(topologyGeneration))
                            {
                                juce::Logger::writeToLog(
                                    "TONE3000 bridge: skipped NAM model request after FX topology changed slot=" + slot);
                                completeSafely(false);
                                return;
                            }

                            if (! safeThis->isNAMModelMutationRequestCurrent(trackId, chainType, fxIndex, slot, requestGeneration))
                            {
                                juce::Logger::writeToLog("TONE3000 bridge: skipped superseded NAM model request slot=" + slot);
                                completeSafely(false);
                                return;
                            }

                            juce::Logger::writeToLog("TONE3000 bridge: loadNAMModelIntoRack started slot=" + slot);
                            juce::DynamicObject::Ptr state = new juce::DynamicObject();
                            if (slot == "pedal")
                            {
                                if (localPath.isNotEmpty())
                                {
                                    state->setProperty("pedalModelPath", localPath);
                                    // A fresh user-selected NAM should publish its
                                    // highest-fidelity graph. Explicit preset/project
                                    // recalls still carry and preserve their saved size.
                                    state->setProperty("pedalModelSize", 1.0);
                                }
                                else
                                    state->setProperty("clearPedalModel", true);
                            }
                            else if (slot == "cab")
                            {
                                if (localPath.isNotEmpty())
                                    state->setProperty("cabIRPath", localPath);
                                else
                                    state->setProperty("clearCabIR", true);
                            }
                            else
                            {
                                if (localPath.isNotEmpty())
                                {
                                    state->setProperty("ampModelPath", localPath);
                                    state->setProperty("ampModelSize", 1.0);
                                }
                                else
                                    state->setProperty("clearAmpModel", true);
                            }

                            const auto publicationLeaseFactory = [safeThis,
                                                           trackId,
                                                           chainType,
                                                           fxIndex,
                                                           slot,
                                                           requestGeneration,
                                                           topologyGeneration]()
                            {
                                if (safeThis == nullptr)
                                    return std::shared_ptr<void>();
                                std::vector<std::pair<juce::String, juce::uint64>> requests {
                                    { slot, requestGeneration }
                                };
                                return safeThis->acquireNAMModelMutationPublicationLease(
                                    trackId, chainType, fxIndex, requests, topologyGeneration);
                            };
                            const bool applied = safeThis->audioEngine.setBuiltInPluginState(
                                trackId,
                                chainType,
                                fxIndex,
                                juce::JSON::toString(juce::var(state.get()), false),
                                publicationLeaseFactory);
                            const bool supersededAfterPublish = ! safeThis->isNAMModelMutationRequestCurrent(
                                trackId, chainType, fxIndex, slot, requestGeneration);
                            const bool result = applied;
                            juce::Logger::writeToLog("TONE3000 bridge: loadNAMModelIntoRack finished slot=" + slot
                                + " result=" + juce::String(result ? "true" : "false")
                                + (supersededAfterPublish
                                    ? juce::String(" supersededAfterPublish=true")
                                    : juce::String()));
                            completeSafely(result);
                        });
                    })
                    .withNativeFunction ("browseForFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto title = args.size() > 0 && args[0].isString()
                            ? args[0].toString()
                            : juce::String("Select File");
                        const auto filters = args.size() > 1 && args[1].isString()
                            ? args[1].toString()
                            : juce::String("*");
                        auto initialDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);

                        fileChooser = std::make_unique<juce::FileChooser>(
                            title,
                            initialDir,
                            filters.isNotEmpty() ? filters : juce::String("*"),
                            true);

                        const auto chooserFlags = juce::FileBrowserComponent::openMode
                                                | juce::FileBrowserComponent::canSelectFiles;
                        fileChooser->launchAsync(chooserFlags, [completion] (const juce::FileChooser& fc) {
                            auto result = fc.getResult();
                            completion(result.existsAsFile() ? result.getFullPathName() : juce::String());
                        });
                    })
                    .withNativeFunction ("browseForFolder", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto title = args.size() > 0 && args[0].isString()
                            ? args[0].toString()
                            : juce::String("Select Folder");
                        auto initialDir = juce::File::getSpecialLocation(juce::File::userHomeDirectory)
                            .getChildFile("Downloads");
                        if (! initialDir.isDirectory())
                            initialDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);

                        fileChooser = std::make_unique<juce::FileChooser>(
                            title,
                            initialDir,
                            "*",
                            true);

                        const auto chooserFlags = juce::FileBrowserComponent::openMode
                                                | juce::FileBrowserComponent::canSelectDirectories;
                        fileChooser->launchAsync(chooserFlags, [completion] (const juce::FileChooser& fc) {
                            auto result = fc.getResult();
                            completion(result.isDirectory() ? result.getFullPathName() : juce::String());
                        });
                    })
                    // ========== Project Save/Load (F2) ==========
                    .withNativeFunction ("showSaveDialog", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Show native save file dialog
                        // Args: [defaultPath (optional), title (optional), filters (optional)]
                        juce::String defaultPath = args.size() > 0 ? args[0].toString() : "";
                        juce::String title = args.size() > 1 ? args[1].toString() : "Save Project";
                        juce::String filters = args.size() > 2 ? args[2].toString() : "";
                        
                        juce::File initialDir = defaultPath.isNotEmpty() 
                            ? juce::File(defaultPath).getParentDirectory()
                            : juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
                        juce::String initialFileName = defaultPath.isNotEmpty()
                            ? juce::File(defaultPath).getFileName()
                            : "Untitled.osproj";
                        
                        // Use async file chooser
                        fileChooser = std::make_unique<juce::FileChooser>(
                            title,
                            initialDir.getChildFile(initialFileName),
                            getDefaultFileFilter(defaultPath, filters, true),
                            true  // Use native dialog
                        );
                        
                        auto chooserFlags = juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles;

                        const auto preferredExtension = getPreferredExtension(defaultPath, filters);

                        fileChooser->launchAsync(chooserFlags, [completion, preferredExtension](const juce::FileChooser& fc) {
                            auto result = fc.getResult();
                            if (result.getFullPathName().isNotEmpty()) {
                                auto path = result.getFullPathName();
                                const auto lowerPath = path.toLowerCase();

                                if (!lowerPath.endsWith(preferredExtension)
                                    && !lowerPath.endsWith(".s13")
                                    && !lowerPath.endsWith(".s13preset")
                                    && !lowerPath.endsWith(".s13nampreset")
                                    && !lowerPath.endsWith(".s13theme"))
                                {
                                    path += preferredExtension;
                                }

                                completion(path);
                            } else {
                                completion("");  // User cancelled
                            }
                        });
                    })
                    .withNativeFunction ("showOpenDialog", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Show native open file dialog
                        // Args: [title (optional), filters (optional)]
                        juce::String title = args.size() > 0 ? args[0].toString() : "Open Project";
                        juce::String filters = args.size() > 1 ? args[1].toString() : "";

                        juce::File initialDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);

                        fileChooser = std::make_unique<juce::FileChooser>(
                            title,
                            initialDir,
                            getDefaultFileFilter(juce::String(), filters, true),
                            true  // Use native dialog
                        );

                        auto chooserFlags = juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles;
                        
                        fileChooser->launchAsync(chooserFlags, [completion](const juce::FileChooser& fc) {
                            auto result = fc.getResult();
                            if (result.existsAsFile()) {
                                completion(result.getFullPathName());
                            } else {
                                completion("");  // User cancelled
                            }
                        });
                    })
                    .withNativeFunction ("saveProjectToFile", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Save project JSON to file
                        // Args: [filePath, jsonContent]
                        if (args.size() == 2 && args[0].isString() && args[1].isString()) {
                            const juce::String filePath = args[0].toString();
                            const juce::String jsonContent = args[1].toString();
                            std::thread(
                                [filePath, jsonContent, completion]() mutable
                                {
                                   #if JUCE_WINDOWS
                                    ::SetThreadPriority(
                                        ::GetCurrentThread(),
                                        THREAD_PRIORITY_BELOW_NORMAL);
                                   #endif
                                    const bool success =
                                        juce::File(filePath)
                                            .replaceWithText(
                                                jsonContent);
                                    juce::MessageManager::callAsync(
                                        [completion, success]()
                                        {
                                            completion(success);
                                        });
                                })
                                .detach();
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("loadProjectFromFile", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Load project JSON from file
                        // Args: [filePath]
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            juce::File file(filePath);
                            
                            if (file.existsAsFile()) {
                                juce::String jsonContent = file.loadFileAsString();
                                juce::Logger::writeToLog("Project loaded from: " + filePath + " (" + juce::String(jsonContent.length()) + " chars)");
                                completion(jsonContent);
                            } else {
                                juce::Logger::writeToLog("Project file not found: " + filePath);
                                completion("");
                            }
                        } else {
                            completion("");
                        }
                    })
                    .withNativeFunction ("getRecentProjects", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(readRecentProjectsFile());
                    })
                    .withNativeFunction ("setRecentProjects", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() != 1)
                        {
                            completion(false);
                            return;
                        }

                        completion(writeRecentProjectsFile(args[0]));
                    })
                    .withNativeFunction ("consumePendingLaunchProjectPath", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(OpenStudioLaunchState::consumePendingProjectPath());
                    })
                    .withNativeFunction ("getPitchRegressionJob", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);

                        if (! isMainWindow()
                            || pitchRegressionJob.isVoid()
                            || pitchRegressionJobConsumed
                            || pitchRegressionJobCompleted)
                        {
                            completion(juce::String());
                            return;
                        }

                        pitchRegressionJobConsumed = true;
                        completion(juce::JSON::toString(pitchRegressionJob, false));
                    })
                    .withNativeFunction ("completePitchRegressionJob", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const auto result = args.size() > 0 ? args[0] : juce::var();
                        completion(completePitchRegressionJob(result));
                    })
                    .withNativeFunction ("getPluginState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Get plugin state as base64 string
                        // Args: [trackId, fxIndex, isInputFX]
                        if (args.size() == 3) {
                            juce::String trackId = args[0].toString();
                            int fxIndex = args[1];
                            bool isInputFX = args[2];
                            juce::String state = audioEngine.getPluginState(trackId, fxIndex, isInputFX);
                            completion(state);
                        } else {
                            completion("");
                        }
                    })
                    .withNativeFunction ("setPluginState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Set plugin state from base64 string
                        // Args: [trackId, fxIndex, isInputFX, base64State]
                        if (args.size() == 4) {
                            const auto trackId = args[0].toString();
                            const auto fxIndex = static_cast<int>(args[1]);
                            const auto isInputFX = static_cast<bool>(args[2]);
                            const auto base64State = args[3].toString();
                            if (! audioEngine.isNAMRackPlugin(trackId, fxIndex, isInputFX))
                            {
                                completion(audioEngine.setPluginState(
                                    trackId, fxIndex, isInputFX, base64State));
                                return;
                            }

                            const auto chainType = isInputFX
                                ? juce::String("input") : juce::String("track");
                            std::vector<std::pair<juce::String, juce::uint64>> namMutationRequests;
                            const auto topologyGeneration = beginNAMModelMutationRequests(
                                trackId, chainType, fxIndex,
                                { "pedal", "amp", "cab" }, namMutationRequests);
                            juce::Component::SafePointer<MainComponent> safeThis(this);
                            builtInStateMutationPool.addJob([
                                safeThis, trackId, chainType, fxIndex, isInputFX,
                                base64State, namMutationRequests, topologyGeneration,
                                completion]() mutable {
                                if (safeThis == nullptr)
                                    return;

                                bool stillCurrent = isNAMRackTopologyCurrent(topologyGeneration);
                                for (const auto& request : namMutationRequests)
                                {
                                    stillCurrent = stillCurrent
                                        && safeThis->isNAMModelMutationRequestCurrent(
                                            trackId, chainType, fxIndex,
                                            request.first, request.second);
                                }
                                if (! stillCurrent)
                                {
                                    juce::MessageManager::callAsync([safeThis, completion]() mutable {
                                        if (safeThis != nullptr)
                                            completion(false);
                                    });
                                    return;
                                }

                                const auto publicationLeaseFactory = [
                                    safeThis, trackId, chainType, fxIndex,
                                    namMutationRequests, topologyGeneration]()
                                {
                                    return safeThis != nullptr
                                        ? safeThis->acquireNAMModelMutationPublicationLease(
                                            trackId, chainType, fxIndex,
                                            namMutationRequests, topologyGeneration)
                                        : std::shared_ptr<void>();
                                };
                                const bool applied = safeThis->audioEngine.setPluginState(
                                    trackId, fxIndex, isInputFX, base64State,
                                    publicationLeaseFactory);
                                const bool result = applied;
                                juce::MessageManager::callAsync([
                                    safeThis, completion, result]() mutable {
                                    if (safeThis != nullptr)
                                        completion(result);
                                });
                            });
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getMasterPluginState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Get master FX plugin state as base64
                        // Args: [fxIndex]
                        if (args.size() == 1) {
                            int fxIndex = args[0];
                            juce::String state = audioEngine.getMasterPluginState(fxIndex);
                            completion(state);
                        } else {
                            completion("");
                        }
                    })
                    .withNativeFunction ("setMasterPluginState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Set master FX plugin state from base64
                        // Args: [fxIndex, base64State]
                        if (args.size() == 2) {
                            const auto fxIndex = static_cast<int>(args[0]);
                            const auto base64State = args[1].toString();
                            if (! audioEngine.isMasterNAMRackPlugin(fxIndex))
                            {
                                completion(audioEngine.setMasterPluginState(fxIndex, base64State));
                                return;
                            }

                            std::vector<std::pair<juce::String, juce::uint64>> namMutationRequests;
                            const auto topologyGeneration = beginNAMModelMutationRequests(
                                {}, "master", fxIndex,
                                { "pedal", "amp", "cab" }, namMutationRequests);
                            juce::Component::SafePointer<MainComponent> safeThis(this);
                            builtInStateMutationPool.addJob([
                                safeThis, fxIndex, base64State, namMutationRequests,
                                topologyGeneration, completion]() mutable {
                                if (safeThis == nullptr)
                                    return;

                                bool stillCurrent = isNAMRackTopologyCurrent(topologyGeneration);
                                for (const auto& request : namMutationRequests)
                                {
                                    stillCurrent = stillCurrent
                                        && safeThis->isNAMModelMutationRequestCurrent(
                                            {}, "master", fxIndex,
                                            request.first, request.second);
                                }
                                if (! stillCurrent)
                                {
                                    juce::MessageManager::callAsync([safeThis, completion]() mutable {
                                        if (safeThis != nullptr)
                                            completion(false);
                                    });
                                    return;
                                }

                                const auto publicationLeaseFactory = [
                                    safeThis, fxIndex, namMutationRequests,
                                    topologyGeneration]()
                                {
                                    return safeThis != nullptr
                                        ? safeThis->acquireNAMModelMutationPublicationLease(
                                            {}, "master", fxIndex,
                                            namMutationRequests, topologyGeneration)
                                        : std::shared_ptr<void>();
                                };
                                const bool result = safeThis->audioEngine.setMasterPluginState(
                                    fxIndex, base64State, publicationLeaseFactory);
                                juce::MessageManager::callAsync([
                                    safeThis, completion, result]() mutable {
                                    if (safeThis != nullptr)
                                        completion(result);
                                });
                            });
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("probeMediaFile", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString())
                            completion(probeReadableMediaFile(args[0].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("requestWaveformPreview", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() < 3 || ! args[0].isString() || ! args[1].isString())
                        {
                            completion(false);
                            return;
                        }

                        const auto filePath = args[0].toString();
                        const auto requestId = args[1].toString();
                        const int maxPoints = juce::jlimit(64, 4096, static_cast<int>(args[2]));

#if JUCE_WINDOWS
                        {
                            const juce::ScopedLock sl(waveformPreviewRequestLock);
                            cancelledWaveformPreviewRequests.erase(requestId);
                        }
#endif

                        juce::Component::SafePointer<MainComponent> safeThis(this);
                        mediaPreviewPool.addJob([safeThis, filePath, requestId, maxPoints]()
                        {
                            if (safeThis == nullptr)
                                return;

#if JUCE_WINDOWS
                            if (safeThis->isWaveformPreviewRequestCancelled(requestId))
                                return;
#endif

                            auto payload = buildWaveformPreviewPayload(requestId, filePath, maxPoints);
                            if (payload.isVoid())
                                return;

#if JUCE_WINDOWS
                            if (safeThis == nullptr || safeThis->isWaveformPreviewRequestCancelled(requestId))
                                return;
#endif

                            safeThis->emitFrontendEvent("waveformPreviewReady", payload);
                        });

                        completion(true);
                    })
                    .withNativeFunction ("cancelWaveformPreview", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString())
                        {
#if JUCE_WINDOWS
                            const juce::ScopedLock sl(waveformPreviewRequestLock);
                            cancelledWaveformPreviewRequests.insert(args[0].toString());
#else
                            juce::ignoreUnused(args);
#endif
                            completion(true);
                            return;
                        }

                        completion(false);
                    })
                    .withNativeFunction ("importMediaFile", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Read audio file metadata (duration, sample rate, channels, format).
                        // For video files that JUCE can't read directly, attempts FFmpeg extraction.
                        // Args: [filePath]
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            juce::File audioFile(filePath);

                            if (!audioFile.existsAsFile()) {
                                juce::Logger::writeToLog("importMediaFile: File not found: " + filePath);
                                completion(juce::var());
                                return;
                            }

                            juce::AudioFormatManager formatManager;
                            formatManager.registerBasicFormats();

                            std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(audioFile));

                            // If JUCE can't read the file directly, try FFmpeg audio extraction
                            // (handles video containers like .mp4, .mkv, .avi, .mov, .webm)
                            juce::File extractedFile;
                            if (!reader) {
                                juce::String ext = audioFile.getFileExtension().toLowerCase();
                                bool isVideoFormat = (ext == ".mp4" || ext == ".mkv" || ext == ".avi" ||
                                                      ext == ".mov" || ext == ".webm" || ext == ".wmv" ||
                                                      ext == ".flv" || ext == ".m4v");

                                if (isVideoFormat) {
                                    juce::Logger::writeToLog("importMediaFile: Attempting FFmpeg audio extraction for: " + filePath);

                                    juce::File tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                                                             .getChildFile("OpenStudio-imports");
                                    tempDir.createDirectory();
                                    extractedFile = tempDir.getChildFile(audioFile.getFileNameWithoutExtension() + "_audio.wav");

                                    // Find FFmpeg: check next to executable first, then fall back to PATH
                                    juce::File appDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
                                    juce::File bundledFFmpeg = appDir.getChildFile("ffmpeg.exe");
                                    juce::String ffmpegPath = bundledFFmpeg.existsAsFile() ? bundledFFmpeg.getFullPathName() : "ffmpeg";

                                    // Run FFmpeg to extract audio as WAV
                                    juce::String cmd = "\"" + ffmpegPath + "\" -y -i \"" + filePath + "\" -vn -acodec pcm_s16le -ar 44100 -ac 2 \"" + extractedFile.getFullPathName() + "\"";

                                    juce::ChildProcess ffmpeg;
                                    bool started = ffmpeg.start(cmd);

                                    if (started) {
                                        // Wait up to 60 seconds for extraction
                                        bool finished = ffmpeg.waitForProcessToFinish(60000);
                                        auto exitCode = ffmpeg.getExitCode();

                                        if (finished && exitCode == 0 && extractedFile.existsAsFile()) {
                                            juce::Logger::writeToLog("importMediaFile: FFmpeg extracted audio to: " + extractedFile.getFullPathName());
                                            reader.reset(formatManager.createReaderFor(extractedFile));
                                        } else {
                                            juce::Logger::writeToLog("importMediaFile: FFmpeg extraction failed (exit code: " + juce::String(exitCode) + ")");
                                        }
                                    } else {
                                        juce::Logger::writeToLog("importMediaFile: FFmpeg not found. Install FFmpeg and add it to PATH to import video files.");
                                    }
                                }
                            }

                            if (!reader) {
                                juce::Logger::writeToLog("importMediaFile: Unsupported format: " + filePath);
                                completion(juce::var());
                                return;
                            }

                            double duration = reader->lengthInSamples / reader->sampleRate;

                            // Use the extracted file path if we did FFmpeg conversion
                            juce::String resultFilePath = extractedFile.existsAsFile() ? extractedFile.getFullPathName() : filePath;

                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("filePath", resultFilePath);
                            result->setProperty("duration", duration);
                            result->setProperty("sampleRate", (int)reader->sampleRate);
                            result->setProperty("numChannels", (int)reader->numChannels);
                            result->setProperty("format", audioFile.getFileExtension().toUpperCase().trimCharactersAtStart("."));

                            juce::Logger::writeToLog("importMediaFile: " + resultFilePath + " - " + juce::String(duration) + "s, " + juce::String((int)reader->sampleRate) + "Hz, " + juce::String((int)reader->numChannels) + "ch");
                            completion(juce::var(result.get()));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("saveDroppedFile", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Save a base64-encoded file dropped from the OS to a temp directory.
                        // Args: [fileName, base64Data]
                        // Returns: the full path to the saved file, or empty string on failure.
                        if (args.size() >= 2 && args[0].isString() && args[1].isString()) {
                            juce::String fileName = args[0].toString();
                            juce::String base64Data = args[1].toString();

                            // Decode standard base64 (from JS btoa()) to binary
                            // Note: MemoryBlock::fromBase64Encoding uses JUCE's non-standard format,
                            // so we must use Base64::convertFromBase64 for standard base64.
                            juce::MemoryOutputStream decoded;
                            if (!juce::Base64::convertFromBase64(decoded, base64Data)) {
                                juce::Logger::writeToLog("saveDroppedFile: Failed to decode base64 for: " + fileName);
                                completion(juce::String(""));
                                return;
                            }

                            // Save to app temp directory
                            juce::File tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                                                     .getChildFile("OpenStudio-imports");
                            tempDir.createDirectory();

                            juce::File destFile = tempDir.getChildFile(fileName);
                            // Avoid overwriting — add a number suffix if the file exists
                            if (destFile.existsAsFile()) {
                                juce::String baseName = destFile.getFileNameWithoutExtension();
                                juce::String ext = destFile.getFileExtension();
                                int counter = 1;
                                while (destFile.existsAsFile()) {
                                    destFile = tempDir.getChildFile(baseName + "_" + juce::String(counter) + ext);
                                    counter++;
                                }
                            }

                            const auto& data = decoded.getMemoryBlock();
                            if (destFile.replaceWithData(data.getData(), data.getSize())) {
                                juce::Logger::writeToLog("saveDroppedFile: Saved " + juce::String((int)data.getSize()) + " bytes to " + destFile.getFullPathName());
                                completion(destFile.getFullPathName());
                            } else {
                                juce::Logger::writeToLog("saveDroppedFile: Failed to write file: " + destFile.getFullPathName());
                                completion(juce::String(""));
                            }
                        } else {
                            juce::Logger::writeToLog("saveDroppedFile: Invalid arguments (expected 2 strings, got " + juce::String(args.size()) + " args)");
                            completion(juce::String(""));
                        }
                    })
                    .withNativeFunction ("showRenderSaveDialog", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Show save dialog for render/export with audio format filter
                        // Args: [defaultFileName, formatExtension, initialDirectory?]
                        juce::String defaultFileName = args.size() > 0 ? args[0].toString() : "untitled";
                        juce::String formatExt = args.size() > 1 ? args[1].toString() : "wav";
                        juce::String initialDirectoryPath = args.size() > 2 ? args[2].toString() : juce::String();

                        juce::File initialDir;
                        if (initialDirectoryPath.isNotEmpty())
                        {
                            const auto requestedDir = juce::File(initialDirectoryPath);
                            if (requestedDir.isDirectory())
                                initialDir = requestedDir;
                        }
                        if (! initialDir.isDirectory())
                            initialDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
                        juce::String filter = "*." + formatExt;
                        juce::String fullFileName = defaultFileName + "." + formatExt;

                        fileChooser = std::make_unique<juce::FileChooser>(
                            "Export Audio",
                            initialDir.getChildFile(fullFileName),
                            filter,
                            true
                        );

                        auto chooserFlags = juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles;

                        fileChooser->launchAsync(chooserFlags, [completion, formatExt](const juce::FileChooser& fc) {
                            auto result = fc.getResult();
                            if (result.getFullPathName().isNotEmpty()) {
                                juce::String path = result.getFullPathName();
                                // Ensure correct extension
                                if (!path.endsWithIgnoreCase("." + formatExt)) {
                                    path += "." + formatExt;
                                }
                                completion(path);
                            } else {
                                completion("");  // User cancelled
                            }
                        });
                    })
                    .withNativeFunction ("renderProject", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Render/Export project to audio file
                        // Args: [source, startTime, endTime, filePath, format, sampleRate, bitDepth, channels, normalize, addTail, tailLength, includeMetronome?]
                        if (args.size() >= 11) {
                            juce::String source = args[0].toString();
                            double startTime = (double)args[1];
                            double endTime = (double)args[2];
                            juce::String filePathArg = args[3].toString();
                            juce::String format = args[4].toString();
                            double sampleRate = (double)args[5];
                            int bitDepth = (int)args[6];
                            int channels = (int)args[7];
                            bool normalizeArg = (bool)args[8];
                            bool addTail = (bool)args[9];
                            double tailLength = (double)args[10];
                            bool includeMetronome = args.size() >= 12 ? (bool)args[11] : false;

                            // Run on background thread to avoid blocking message thread
                            std::thread([this, source, startTime, endTime, filePathArg, format,
                                         sampleRate, bitDepth, channels, normalizeArg, addTail, tailLength,
                                         includeMetronome,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                                bool success = audioEngine.renderProject(
                                    source, startTime, endTime, filePathArg, format,
                                    sampleRate, bitDepth, channels, normalizeArg, addTail, tailLength,
                                    includeMetronome);
                                // Call completion on the message thread to avoid crash
                                // (WebView callbacks must not be invoked from background threads)
                                juce::MessageManager::callAsync([completion, success]() {
                                    (*completion)(success);
                                });
                            }).detach();
                        } else {
                            juce::Logger::writeToLog("renderProject: Invalid args count: " + juce::String(args.size()));
                            completion(false);
                        }
                    })
                    .withNativeFunction ("capturePitchAuditionPlayback", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Capture the current live playback-engine source for a clip after pitch apply.
                        // Args: [trackId, clipId, startTime, duration, filePath, sampleRate, offlineRenderMode?]
                        if (args.size() >= 5) {
                            juce::String trackId = args[0].toString();
                            juce::String clipId = args[1].toString();
                            double startTime = static_cast<double>(args[2]);
                            double duration = static_cast<double>(args[3]);
                            juce::String filePathArg = args[4].toString();
                            double sampleRate = args.size() >= 6 ? static_cast<double>(args[5]) : 44100.0;
                            bool offlineRenderMode = args.size() >= 7 ? static_cast<bool>(args[6]) : true;

                            std::thread([this, trackId, clipId, startTime, duration, filePathArg, sampleRate,
                                         offlineRenderMode,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                auto result = audioEngine.capturePitchAuditionPlayback(trackId, clipId, startTime, duration, filePathArg, sampleRate, offlineRenderMode);
                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(result);
                                });
                            }).detach();
                        } else {
                            juce::Logger::writeToLog("capturePitchAuditionPlayback: Invalid args count: " + juce::String(args.size()));
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("capturePitchAppFinalContext", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Capture the actual playback-engine route after final note-HQ apply.
                        // Args: [trackId, clipId, startTime, duration, wavPath, routeJsonPath, sampleRate, metadata?]
                        if (args.size() >= 6) {
                            juce::String trackId = args[0].toString();
                            juce::String clipId = args[1].toString();
                            double startTime = static_cast<double>(args[2]);
                            double duration = static_cast<double>(args[3]);
                            juce::String wavPath = args[4].toString();
                            juce::String routeJsonPath = args[5].toString();
                            double sampleRate = args.size() >= 7 ? static_cast<double>(args[6]) : 44100.0;
                            juce::var metadata = args.size() >= 8 ? args[7] : juce::var();

                            std::thread([this, trackId, clipId, startTime, duration, wavPath, routeJsonPath, sampleRate, metadata,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                const juce::File liveWav(wavPath);
                                const auto liveStem = liveWav.getFileNameWithoutExtension();
                                const auto bakedWav = liveWav.getSiblingFile(liveStem + "_baked_corrected.wav");
                                const auto offlineWav = liveWav.getSiblingFile(liveStem + "_offline_render.wav");
                                const auto compareJson = liveWav.getSiblingFile(liveStem + "_comparison.json");
                                const auto routeBefore = audioEngine.getPitchPreviewRoutingStatus(clipId);
                                auto capture = audioEngine.capturePitchAuditionPlayback(trackId, clipId, startTime, duration, wavPath, sampleRate, false);
                                auto offlineCapture = audioEngine.capturePitchAuditionPlayback(trackId, clipId, startTime, duration, offlineWav.getFullPathName(), sampleRate, true);
                                const auto routeAfter = audioEngine.getPitchPreviewRoutingStatus(clipId);
                                juce::var bakedCapture;
                                juce::var bakedVsLive;
                                juce::var bakedVsOffline;
                                juce::var liveVsOffline;

                                const auto outputFile = metadata.getProperty("outputFile", {}).toString();
                                const double captureStartClipSec = static_cast<double>(metadata.getProperty("clipContextStartSec", 0.0));
                                const double noteStartSec = static_cast<double>(metadata.getProperty("noteStartSec", captureStartClipSec));
                                const double noteEndSec = static_cast<double>(metadata.getProperty("noteEndSec", captureStartClipSec + duration));
                                if (outputFile.isNotEmpty())
                                {
                                    bakedCapture = audioEngine.capturePitchBakedContext(outputFile,
                                                                                       captureStartClipSec,
                                                                                       duration,
                                                                                       bakedWav.getFullPathName());
                                    if (static_cast<bool>(bakedCapture.getProperty("success", false)))
                                    {
                                        bakedVsLive = audioEngine.comparePitchDebugAudioFiles(bakedWav.getFullPathName(),
                                                                                             liveWav.getFullPathName(),
                                                                                             captureStartClipSec,
                                                                                             noteStartSec,
                                                                                             noteEndSec);
                                        bakedVsOffline = audioEngine.comparePitchDebugAudioFiles(bakedWav.getFullPathName(),
                                                                                                offlineWav.getFullPathName(),
                                                                                                captureStartClipSec,
                                                                                                noteStartSec,
                                                                                                noteEndSec);
                                    }
                                }
                                liveVsOffline = audioEngine.comparePitchDebugAudioFiles(liveWav.getFullPathName(),
                                                                                       offlineWav.getFullPathName(),
                                                                                       captureStartClipSec,
                                                                                       noteStartSec,
                                                                                       noteEndSec);

                                auto* resultObj = new juce::DynamicObject();
                                resultObj->setProperty("success", capture.isObject() && static_cast<bool>(capture.getProperty("success", false)));
                                resultObj->setProperty("trackId", trackId);
                                resultObj->setProperty("clipId", clipId);
                                resultObj->setProperty("capture", capture);
                                resultObj->setProperty("livePlaybackCapture", capture);
                                resultObj->setProperty("offlineRenderCapture", offlineCapture);
                                if (! bakedCapture.isVoid())
                                    resultObj->setProperty("bakedCorrectedCapture", bakedCapture);
                                if (! bakedVsLive.isVoid())
                                    resultObj->setProperty("bakedVsLiveParityReport", bakedVsLive);
                                if (! bakedVsOffline.isVoid())
                                    resultObj->setProperty("bakedVsOfflineParityReport", bakedVsOffline);
                                if (! liveVsOffline.isVoid())
                                    resultObj->setProperty("liveVsOfflineParityReport", liveVsOffline);
                                resultObj->setProperty("routeBefore", routeBefore);
                                resultObj->setProperty("routeAfter", routeAfter);
                                resultObj->setProperty("routeReportPath", routeJsonPath);
                                resultObj->setProperty("bakedCorrectedPath", bakedWav.getFullPathName());
                                resultObj->setProperty("livePlaybackPath", liveWav.getFullPathName());
                                resultObj->setProperty("offlineRenderPath", offlineWav.getFullPathName());
                                resultObj->setProperty("comparisonReportPath", compareJson.getFullPathName());
                                resultObj->setProperty("capturedAt", juce::Time::getCurrentTime().toISO8601(true));
                                if (! metadata.isVoid())
                                    resultObj->setProperty("metadata", metadata);

                                juce::var result(resultObj);
                                compareJson.getParentDirectory().createDirectory();
                                auto* compareObj = new juce::DynamicObject();
                                compareObj->setProperty("bakedCorrectedPath", bakedWav.getFullPathName());
                                compareObj->setProperty("livePlaybackPath", liveWav.getFullPathName());
                                compareObj->setProperty("offlineRenderPath", offlineWav.getFullPathName());
                                compareObj->setProperty("bakedVsLiveParityReport", bakedVsLive);
                                compareObj->setProperty("bakedVsOfflineParityReport", bakedVsOffline);
                                compareObj->setProperty("liveVsOfflineParityReport", liveVsOffline);
                                compareJson.replaceWithText(juce::JSON::toString(juce::var(compareObj), true));
                                if (routeJsonPath.isNotEmpty())
                                {
                                    const juce::File routeFile(routeJsonPath);
                                    routeFile.getParentDirectory().createDirectory();
                                    const bool wrote = routeFile.replaceWithText(juce::JSON::toString(result, true));
                                    resultObj->setProperty("routeReportWritten", wrote);
                                    if (! wrote)
                                        juce::Logger::writeToLog("capturePitchAppFinalContext: failed to write route report " + routeFile.getFullPathName());
                                }

                                juce::Logger::writeToLog("capturePitchAppFinalContext clip=" + clipId
                                    + " wav=" + wavPath
                                    + " routeReport=" + routeJsonPath
                                    + " success=" + juce::String(static_cast<bool>(resultObj->getProperty("success")) ? "true" : "false"));

                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(result);
                                });
                            }).detach();
                        } else {
                            juce::Logger::writeToLog("capturePitchAppFinalContext: Invalid args count: " + juce::String(args.size()));
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("renderProjectWithDither", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [source, startTime, endTime, filePath, format, sampleRate, bitDepth, channels, normalize, addTail, tailLength, ditherType, includeMetronome?]
                        if (args.size() >= 12) {
                            juce::String source = args[0].toString();
                            double startTime = (double)args[1];
                            double endTime = (double)args[2];
                            juce::String filePathArg = args[3].toString();
                            juce::String format = args[4].toString();
                            double sampleRate = (double)args[5];
                            int bitDepth = (int)args[6];
                            int channels = (int)args[7];
                            bool normalizeArg = (bool)args[8];
                            bool addTail = (bool)args[9];
                            double tailLength = (double)args[10];
                            juce::String ditherType = args[11].toString();
                            bool includeMetronome = args.size() >= 13 ? (bool)args[12] : false;

                            std::thread([this, source, startTime, endTime, filePathArg, format,
                                         sampleRate, bitDepth, channels, normalizeArg, addTail, tailLength, ditherType,
                                         includeMetronome,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                                bool success = audioEngine.renderProjectWithDither(
                                    source, startTime, endTime, filePathArg, format,
                                    sampleRate, bitDepth, channels, normalizeArg, addTail, tailLength, ditherType,
                                    includeMetronome);
                                juce::MessageManager::callAsync([completion, success]() {
                                    (*completion)(success);
                                });
                            }).detach();
                        } else {
                            completion(false);
                        }
                    })
                    // ===== Phase 9: Audio Engine Enhancements =====
                    .withNativeFunction ("reverseAudioFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9A: Reverse an audio file
                        // Args: [filePath] -> returns path to reversed file
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            std::thread([this, filePath,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                juce::String reversedPath = audioEngine.getAudioAnalyzer().reverseAudioFile(filePath);
                                juce::MessageManager::callAsync([completion, reversedPath]() {
                                    (*completion)(reversedPath);
                                });
                            }).detach();
                        } else {
                            completion(juce::String());
                        }
                    })
                    .withNativeFunction ("detectTransients", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9B: Detect transients in an audio file
                        // Args: [filePath, sensitivity, minGapMs] -> returns array of times (seconds)
                        if (args.size() == 3 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double sensitivity = (double)args[1];
                            double minGapMs = (double)args[2];
                            std::thread([this, filePath, sensitivity, minGapMs,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                auto transients = audioEngine.getAudioAnalyzer().detectTransients(filePath, sensitivity, minGapMs);
                                juce::Array<juce::var> result;
                                for (double t : transients)
                                    result.add(t);
                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(juce::var(result));
                                });
                            }).detach();
                        } else {
                            completion(juce::var(juce::Array<juce::var>()));
                        }
                    })
                    .withNativeFunction ("setMetronomeClickSound", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9C: Set custom click sound for regular beats
                        // Args: [filePath] — empty string to reset to default
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            bool success = audioEngine.setMetronomeClickSound(filePath);
                            completion(success);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setMetronomeAccentSound", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9C: Set custom accent sound for accented beats
                        // Args: [filePath] — empty string to reset to default
                        if (args.size() == 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            bool success = audioEngine.setMetronomeAccentSound(filePath);
                            completion(success);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("resetMetronomeSounds", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9C: Reset metronome to default synthesized sounds
                        juce::ignoreUnused(args);
                        audioEngine.resetMetronomeSounds();
                        completion(true);
                    })
                    // ===== Phase 11: Send/Bus Routing =====
                    .withNativeFunction ("addTrackSend", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            int idx = audioEngine.addTrackSend(args[0].toString(), args[1].toString());
                            completion(idx);
                        } else {
                            completion(-1);
                        }
                    })
                    .withNativeFunction ("removeTrackSend", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.removeTrackSend(args[0].toString(), (int)args[1]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackSendLevel", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackSendLevel(args[0].toString(), (int)args[1], (float)(double)args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackSendPan", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackSendPan(args[0].toString(), (int)args[1], (float)(double)args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackSendEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackSendEnabled(args[0].toString(), (int)args[1], (bool)args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setTrackSendPreFader", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackSendPreFader(args[0].toString(), (int)args[1], (bool)args[2]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getTrackSends", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackSends(args[0].toString()));
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("setTrackSendPhaseInvert", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackSendPhaseInvert(args[0].toString(), (int)args[1], (bool)args[2]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setTrackPhaseInvert", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackPhaseInvert(args[0].toString(), (bool)args[1]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackPhaseInvert", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackPhaseInvert(args[0].toString()));
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setTrackStereoWidth", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackStereoWidth(args[0].toString(), (float)(double)args[1]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackStereoWidth", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackStereoWidth(args[0].toString()));
                        } else { completion(100.0f); }
                    })
                    .withNativeFunction ("setTrackMasterSendEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackMasterSendEnabled(args[0].toString(), (bool)args[1]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackMasterSendEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackMasterSendEnabled(args[0].toString()));
                        } else { completion(true); }
                    })
                    .withNativeFunction ("setTrackOutputChannels", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setTrackOutputChannels(args[0].toString(), (int)args[1], (int)args[2]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setTrackPlaybackOffset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackPlaybackOffset(args[0].toString(), (double)args[1]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackPlaybackOffset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackPlaybackOffset(args[0].toString()));
                        } else { completion(0.0); }
                    })
                    .withNativeFunction ("setTrackChannelCount", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackChannelCount(args[0].toString(), (int)args[1]);
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackChannelCount", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackChannelCount(args[0].toString()));
                        } else { completion(2); }
                    })
                    .withNativeFunction ("setTrackMIDIOutput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.setTrackMIDIOutput(args[0].toString(), args[1].toString());
                            completion(true);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("getTrackMIDIOutput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackMIDIOutput(args[0].toString()));
                        } else { completion(juce::String()); }
                    })
                    .withNativeFunction ("getTrackRoutingInfo", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            completion(audioEngine.getTrackRoutingInfo(args[0].toString()));
                        } else { completion(juce::var()); }
                    })
                    .withNativeFunction ("measureLUFS", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Phase 9D: Measure LUFS for an audio file
                        // Args: [filePath, startTime?, endTime?] -> returns {integrated, shortTerm, momentary, truePeak, range}
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double startTime = args.size() > 1 ? (double)args[1] : 0.0;
                            double endTime = args.size() > 2 ? (double)args[2] : 0.0;
                            std::thread([this, filePath, startTime, endTime,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                auto lufs = audioEngine.getAudioAnalyzer().measureLUFS(filePath, startTime, endTime);
                                auto* resultObj = new juce::DynamicObject();
                                resultObj->setProperty("integrated", lufs.integrated);
                                resultObj->setProperty("shortTerm", lufs.shortTerm);
                                resultObj->setProperty("momentary", lufs.momentary);
                                resultObj->setProperty("truePeak", lufs.truePeak);
                                resultObj->setProperty("range", lufs.range);
                                juce::var resultVar(resultObj);
                                juce::MessageManager::callAsync([completion, resultVar]() {
                                    (*completion)(resultVar);
                                });
                            }).detach();
                        } else {
                            completion(false);
                        }
                    })
                    // ===== Phase 12: Media & File Management =====
                    .withNativeFunction ("browseDirectory", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [directoryPath]
                        // Returns: Array of {name, path, size, isDirectory, format, duration, sampleRate, numChannels}
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String dirPath = args[0].toString();
                            juce::File dir(dirPath);

                            if (!dir.isDirectory()) {
                                completion(juce::Array<juce::var>());
                                return;
                            }

                            auto files = dir.findChildFiles(juce::File::findFilesAndDirectories, false);
                            files.sort();

                            juce::Array<juce::var> result;
                            juce::AudioFormatManager formatMgr;
                            formatMgr.registerBasicFormats();

                            for (const auto& file : files) {
                                auto* obj = new juce::DynamicObject();
                                obj->setProperty("name", file.getFileName());
                                obj->setProperty("path", file.getFullPathName());
                                obj->setProperty("size", (juce::int64)file.getSize());
                                obj->setProperty("isDirectory", file.isDirectory());

                                if (!file.isDirectory()) {
                                    juce::String ext = file.getFileExtension().toLowerCase();
                                    obj->setProperty("format", ext.substring(1)); // Remove leading dot

                                    // Try to read audio metadata
                                    std::unique_ptr<juce::AudioFormatReader> reader(formatMgr.createReaderFor(file));
                                    if (reader) {
                                        double duration = reader->lengthInSamples / reader->sampleRate;
                                        obj->setProperty("duration", duration);
                                        obj->setProperty("sampleRate", (int)reader->sampleRate);
                                        obj->setProperty("numChannels", (int)reader->numChannels);
                                    } else {
                                        obj->setProperty("duration", 0.0);
                                        obj->setProperty("sampleRate", 0);
                                        obj->setProperty("numChannels", 0);
                                    }
                                } else {
                                    obj->setProperty("format", "");
                                    obj->setProperty("duration", 0.0);
                                    obj->setProperty("sampleRate", 0);
                                    obj->setProperty("numChannels", 0);
                                }

                                result.add(juce::var(obj));
                            }

                            completion(result);
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    .withNativeFunction ("previewAudioFile", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Preview an audio file through the output device (not through the track graph)
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            // For now, just log - full preview would require a separate AudioSource
                            juce::Logger::writeToLog("previewAudioFile: " + filePath);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("stopPreview", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        juce::Logger::writeToLog("stopPreview called");
                        completion(true);
                    })
                    .withNativeFunction ("cleanProjectDirectory", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [projectDir, referencedFilesArray]
                        // Returns: { orphanedFiles: Array<{path, size}>, totalSize }
                        if (args.size() >= 2 && args[0].isString() && args[1].isArray()) {
                            juce::String projectDir = args[0].toString();
                            auto* refArray = args[1].getArray();

                            // Build set of referenced file paths (normalized)
                            std::set<juce::String> referencedPaths;
                            if (refArray) {
                                for (const auto& ref : *refArray) {
                                    referencedPaths.insert(juce::File(ref.toString()).getFullPathName().toLowerCase());
                                }
                            }

                            juce::File dir(projectDir);
                            auto allFiles = dir.findChildFiles(juce::File::findFiles, true);

                            juce::Array<juce::var> orphanedFiles;
                            juce::int64 totalSize = 0;

                            for (const auto& file : allFiles) {
                                juce::String normalized = file.getFullPathName().toLowerCase();
                                // Skip project files (.s13proj, .json)
                                juce::String ext = file.getFileExtension().toLowerCase();
                                if (ext == ".s13proj" || ext == ".json" || ext == ".bak") continue;

                                if (referencedPaths.find(normalized) == referencedPaths.end()) {
                                    auto* obj = new juce::DynamicObject();
                                    obj->setProperty("path", file.getFullPathName());
                                    obj->setProperty("size", (juce::int64)file.getSize());
                                    orphanedFiles.add(juce::var(obj));
                                    totalSize += file.getSize();
                                }
                            }

                            auto* resultObj = new juce::DynamicObject();
                            resultObj->setProperty("orphanedFiles", orphanedFiles);
                            resultObj->setProperty("totalSize", totalSize);
                            completion(juce::var(resultObj));
                        } else {
                            auto* resultObj = new juce::DynamicObject();
                            resultObj->setProperty("orphanedFiles", juce::Array<juce::var>());
                            resultObj->setProperty("totalSize", 0);
                            completion(juce::var(resultObj));
                        }
                    })
                    .withNativeFunction ("deleteFiles", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [filePathsArray]
                        // Returns: { deleted: number, errors: string[] }
                        if (args.size() >= 1 && args[0].isArray()) {
                            auto* pathArray = args[0].getArray();
                            int deletedCount = 0;
                            juce::Array<juce::var> errors;

                            if (pathArray) {
                                for (const auto& pathVar : *pathArray) {
                                    juce::File file(pathVar.toString());
                                    if (file.deleteFile()) {
                                        deletedCount++;
                                    } else {
                                        errors.add("Failed to delete: " + file.getFullPathName());
                                    }
                                }
                            }

                            auto* resultObj = new juce::DynamicObject();
                            resultObj->setProperty("deleted", deletedCount);
                            resultObj->setProperty("errors", errors);
                            completion(juce::var(resultObj));
                        } else {
                            auto* resultObj = new juce::DynamicObject();
                            resultObj->setProperty("deleted", 0);
                            resultObj->setProperty("errors", juce::Array<juce::var>());
                            completion(juce::var(resultObj));
                        }
                    })
                    .withNativeFunction ("exportProjectMIDI", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [filePath, midiTracks]
                        // midiTracks is an array of { name, clips: [{ startTime, duration, events }] }.
                        if (args.size() >= 2 && args[0].isString() && args[1].isArray()) {
                            completion(audioEngine.exportProjectMIDI(args[0].toString(), args[1], 120.0));
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("convertAudioFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [inputPath, outputPath, format, sampleRate, bitDepth, channels]
                        if (args.size() >= 6 && args[0].isString() && args[1].isString()) {
                            juce::String inputPath = args[0].toString();
                            juce::String outputPath = args[1].toString();
                            juce::String format = args[2].toString();
                            int targetSampleRate = (int)args[3];
                            int targetBitDepth = (int)args[4];
                            int targetChannels = (int)args[5];

                            std::thread([inputPath, outputPath, format, targetSampleRate, targetBitDepth, targetChannels,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                juce::AudioFormatManager formatMgr;
                                formatMgr.registerBasicFormats();

                                juce::File inFile(inputPath);
                                std::unique_ptr<juce::AudioFormatReader> reader(formatMgr.createReaderFor(inFile));

                                if (!reader) {
                                    juce::MessageManager::callAsync([completion]() { (*completion)(false); });
                                    return;
                                }

                                // Choose output format
                                juce::AudioFormat* outputFormat = nullptr;
                                if (format == "wav") outputFormat = formatMgr.findFormatForFileExtension("wav");
                                else if (format == "aiff") outputFormat = formatMgr.findFormatForFileExtension("aiff");
                                else if (format == "flac") outputFormat = formatMgr.findFormatForFileExtension("flac");
                                else outputFormat = formatMgr.findFormatForFileExtension("wav"); // Default to WAV

                                if (!outputFormat) {
                                    juce::MessageManager::callAsync([completion]() { (*completion)(false); });
                                    return;
                                }

                                juce::File outFile(outputPath);
                                outFile.deleteFile();
                                std::unique_ptr<juce::OutputStream> stream(outFile.createOutputStream());

                                if (!stream) {
                                    juce::MessageManager::callAsync([completion]() { (*completion)(false); });
                                    return;
                                }

                                int outChannels = targetChannels > 0 ? targetChannels : (int)reader->numChannels;
                                int outSampleRate = targetSampleRate > 0 ? targetSampleRate : (int)reader->sampleRate;
                                int outBitDepth = targetBitDepth > 0 ? targetBitDepth : (int)reader->bitsPerSample;

                                auto writer = outputFormat->createWriterFor(
                                    stream,
                                    juce::AudioFormatWriterOptions()
                                        .withSampleRate(outSampleRate)
                                        .withNumChannels(outChannels)
                                        .withBitsPerSample(outBitDepth));

                                if (!writer) {
                                    juce::MessageManager::callAsync([completion]() { (*completion)(false); });
                                    return;
                                }

                                // Read and write in blocks
                                const int blockSize = 8192;
                                juce::AudioBuffer<float> buffer(outChannels, blockSize);
                                juce::int64 totalSamples = reader->lengthInSamples;
                                juce::int64 written = 0;

                                while (written < totalSamples) {
                                    int samplesToRead = (int)std::min((juce::int64)blockSize, totalSamples - written);
                                    buffer.clear();
                                    reader->read(&buffer, 0, samplesToRead, written, true, true);
                                    writer->writeFromAudioSampleBuffer(buffer, 0, samplesToRead);
                                    written += samplesToRead;
                                }

                                writer.reset();

                                juce::MessageManager::callAsync([completion]() { (*completion)(true); });
                            }).detach();
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getHomeDirectory", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(juce::File::getSpecialLocation(juce::File::userHomeDirectory).getFullPathName());
                    })
                    // ===== Phase 13: Advanced Editing =====
                    .withNativeFunction ("timeStretchClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [filePath, factor] -> returns JSON {success, filePath, duration, sampleRate}
                        // factor: atempo value — 2.0 = double speed (half duration), 0.5 = half speed (double duration)
                        if (args.size() >= 2 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double factor = (double)args[1];

                            if (factor <= 0.0 || std::abs(factor - 1.0) < 0.0001) {
                                completion(juce::String()); // No change needed
                                return;
                            }

                            juce::File inputFile(filePath);
                            juce::String timestamp = juce::String(juce::Time::currentTimeMillis());
                            juce::File outputFile = inputFile.getSiblingFile(
                                inputFile.getFileNameWithoutExtension() + "_ts_" + timestamp + inputFile.getFileExtension()
                            );

                            // Find FFmpeg
                            auto exeDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
                            juce::File ffmpeg = exeDir.getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) ffmpeg = exeDir.getChildFile("tools").getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) ffmpeg = exeDir.getParentDirectory().getChildFile("tools").getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) {
                                completion(juce::String());
                                return;
                            }
                            juce::String ffmpegPath = ffmpeg.getFullPathName();

                            std::thread([filePath, outputFile, factor, ffmpegPath,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                // Build atempo filter chain — atempo supports [0.5, 100.0]
                                juce::String atempoFilter;
                                double remaining = factor;
                                if (remaining < 0.5) {
                                    while (remaining < 0.5) {
                                        atempoFilter += (atempoFilter.isEmpty() ? "" : ",") + juce::String("atempo=0.5");
                                        remaining /= 0.5;
                                    }
                                    if (std::abs(remaining - 1.0) > 0.0001)
                                        atempoFilter += ",atempo=" + juce::String(remaining);
                                } else if (remaining > 100.0) {
                                    while (remaining > 100.0) {
                                        atempoFilter += (atempoFilter.isEmpty() ? "" : ",") + juce::String("atempo=100.0");
                                        remaining /= 100.0;
                                    }
                                    if (std::abs(remaining - 1.0) > 0.0001)
                                        atempoFilter += ",atempo=" + juce::String(remaining);
                                } else {
                                    atempoFilter = "atempo=" + juce::String(factor);
                                }

                                juce::StringArray processArgs;
                                processArgs.add(ffmpegPath);
                                processArgs.add("-y");
                                processArgs.add("-i");
                                processArgs.add(filePath);
                                processArgs.add("-af");
                                processArgs.add(atempoFilter);
                                processArgs.add(outputFile.getFullPathName());

                                juce::ChildProcess process;
                                bool started = process.start(processArgs);
                                bool finished = started && process.waitForProcessToFinish(120000);
                                int exitCode = finished ? process.getExitCode() : -1;

                                juce::DynamicObject::Ptr result = new juce::DynamicObject();
                                if (exitCode == 0 && outputFile.existsAsFile()) {
                                    result->setProperty("success", true);
                                    result->setProperty("filePath", outputFile.getFullPathName());
                                    // Read output file to get duration and sample rate
                                    juce::AudioFormatManager fmgr;
                                    fmgr.registerBasicFormats();
                                    std::unique_ptr<juce::AudioFormatReader> reader(fmgr.createReaderFor(outputFile));
                                    if (reader) {
                                        result->setProperty("duration", (double)reader->lengthInSamples / reader->sampleRate);
                                        result->setProperty("sampleRate", reader->sampleRate);
                                    }
                                } else {
                                    result->setProperty("success", false);
                                }

                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(juce::var(result.get()));
                                });
                            }).detach();
                        } else {
                            completion(juce::String());
                        }
                    })
                    .withNativeFunction ("pitchShiftClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [filePath, semitones] -> returns JSON {success, filePath, duration, sampleRate}
                        // Uses asetrate to change pitch, aresample to fix SR, atempo to compensate duration
                        if (args.size() >= 2 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double semitones = (double)args[1];

                            if (std::abs(semitones) < 0.01) {
                                completion(juce::String()); // No change needed
                                return;
                            }

                            juce::File inputFile(filePath);
                            juce::String timestamp = juce::String(juce::Time::currentTimeMillis());
                            juce::File outputFile = inputFile.getSiblingFile(
                                inputFile.getFileNameWithoutExtension() + "_ps_" + timestamp + inputFile.getFileExtension()
                            );

                            // Detect file's actual sample rate
                            double fileSampleRate = 44100.0;
                            {
                                juce::AudioFormatManager fmgr;
                                fmgr.registerBasicFormats();
                                std::unique_ptr<juce::AudioFormatReader> reader(fmgr.createReaderFor(inputFile));
                                if (reader)
                                    fileSampleRate = reader->sampleRate;
                            }

                            // Convert semitones to frequency ratio: ratio = 2^(semitones/12)
                            double ratio = std::pow(2.0, semitones / 12.0);

                            // Find FFmpeg
                            auto exeDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
                            juce::File ffmpeg = exeDir.getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) ffmpeg = exeDir.getChildFile("tools").getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) ffmpeg = exeDir.getParentDirectory().getChildFile("tools").getChildFile("ffmpeg.exe");
                            if (!ffmpeg.existsAsFile()) {
                                completion(juce::String());
                                return;
                            }
                            juce::String ffmpegPath = ffmpeg.getFullPathName();
                            int srInt = (int)fileSampleRate;

                            std::thread([filePath, outputFile, ratio, ffmpegPath, srInt,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                // asetrate changes pitch+speed, aresample restores SR, atempo compensates speed
                                // Tempo compensation: 1/ratio — need to chain if outside [0.5, 100.0]
                                double tempoComp = 1.0 / ratio;
                                juce::String atempoChain;
                                double remaining = tempoComp;
                                if (remaining < 0.5) {
                                    while (remaining < 0.5) {
                                        atempoChain += ",atempo=0.5";
                                        remaining /= 0.5;
                                    }
                                    if (std::abs(remaining - 1.0) > 0.0001)
                                        atempoChain += ",atempo=" + juce::String(remaining);
                                } else if (remaining > 100.0) {
                                    while (remaining > 100.0) {
                                        atempoChain += ",atempo=100.0";
                                        remaining /= 100.0;
                                    }
                                    if (std::abs(remaining - 1.0) > 0.0001)
                                        atempoChain += ",atempo=" + juce::String(remaining);
                                } else {
                                    atempoChain = ",atempo=" + juce::String(tempoComp);
                                }

                                // Full filter: asetrate=SR*ratio,aresample=SR,atempo=1/ratio
                                juce::String filter = "asetrate=" + juce::String(srInt) + "*" + juce::String(ratio)
                                                    + ",aresample=" + juce::String(srInt)
                                                    + atempoChain;

                                juce::StringArray processArgs;
                                processArgs.add(ffmpegPath);
                                processArgs.add("-y");
                                processArgs.add("-i");
                                processArgs.add(filePath);
                                processArgs.add("-af");
                                processArgs.add(filter);
                                processArgs.add(outputFile.getFullPathName());

                                juce::ChildProcess process;
                                bool started = process.start(processArgs);
                                bool finished = started && process.waitForProcessToFinish(120000);
                                int exitCode = finished ? process.getExitCode() : -1;

                                juce::DynamicObject::Ptr result = new juce::DynamicObject();
                                if (exitCode == 0 && outputFile.existsAsFile()) {
                                    result->setProperty("success", true);
                                    result->setProperty("filePath", outputFile.getFullPathName());
                                    juce::AudioFormatManager fmgr;
                                    fmgr.registerBasicFormats();
                                    std::unique_ptr<juce::AudioFormatReader> reader(fmgr.createReaderFor(outputFile));
                                    if (reader) {
                                        result->setProperty("duration", (double)reader->lengthInSamples / reader->sampleRate);
                                        result->setProperty("sampleRate", reader->sampleRate);
                                    }
                                } else {
                                    result->setProperty("success", false);
                                }

                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(juce::var(result.get()));
                                });
                            }).detach();
                        } else {
                            completion(juce::String());
                        }
                    })
                    // ========== Phase 3.10: Control Surface Support ==========
                    .withNativeFunction ("connectMIDIControlSurface", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [midiInputName, midiOutputName]
                        juce::String inputName = args.size() > 0 ? args[0].toString() : "";
                        juce::String outputName = args.size() > 1 ? args[1].toString() : "";
                        bool ok = audioEngine.getControlSurfaceManager().getMIDIControl().connect(inputName, outputName);
                        completion(ok);
                    })
                    .withNativeFunction ("disconnectMIDIControlSurface", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getControlSurfaceManager().getMIDIControl().disconnect();
                        completion(true);
                    })
                    .withNativeFunction ("startMIDILearn", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [trackId, parameter]
                        if (args.size() >= 2) {
                            audioEngine.getControlSurfaceManager().getMIDIControl().startLearn(
                                args[0].toString(), args[1].toString());
                        }
                        completion(true);
                    })
                    .withNativeFunction ("cancelMIDILearn", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getControlSurfaceManager().getMIDIControl().cancelLearn();
                        completion(true);
                    })
                    .withNativeFunction ("getMIDIMappings", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        auto mappings = audioEngine.getControlSurfaceManager().getMIDIControl().getMappings();
                        juce::Array<juce::var> arr;
                        for (const auto& m : mappings) {
                            juce::DynamicObject::Ptr obj = new juce::DynamicObject();
                            obj->setProperty("channel", m.channel);
                            obj->setProperty("cc", m.cc);
                            obj->setProperty("trackId", m.trackId);
                            obj->setProperty("parameter", m.parameter);
                            arr.add(juce::var(obj.get()));
                        }
                        completion(juce::var(arr));
                    })
                    .withNativeFunction ("addMIDIMapping", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [channel, cc, trackId, parameter]
                        if (args.size() >= 4) {
                            MIDICCMapping m;
                            m.channel = (int)args[0];
                            m.cc = (int)args[1];
                            m.trackId = args[2].toString();
                            m.parameter = args[3].toString();
                            audioEngine.getControlSurfaceManager().getMIDIControl().addMapping(m);
                        }
                        completion(true);
                    })
                    .withNativeFunction ("removeMIDIMapping", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [channel, cc]
                        if (args.size() >= 2) {
                            audioEngine.getControlSurfaceManager().getMIDIControl().removeMapping(
                                (int)args[0], (int)args[1]);
                        }
                        completion(true);
                    })
                    .withNativeFunction ("connectOSC", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [receivePort, sendHost, sendPort]
                        int recvPort = args.size() > 0 ? (int)args[0] : 8000;
                        juce::String sendHost = args.size() > 1 ? args[1].toString() : "127.0.0.1";
                        int sendPort = args.size() > 2 ? (int)args[2] : 9000;
                        bool ok = audioEngine.getControlSurfaceManager().getOSCControl().connect(recvPort, sendHost, sendPort);
                        completion(ok);
                    })
                    .withNativeFunction ("disconnectOSC", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getControlSurfaceManager().getOSCControl().disconnect();
                        completion(true);
                    })
                    .withNativeFunction ("getControlSurfaceMIDIDevices", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        juce::DynamicObject::Ptr result = new juce::DynamicObject();
                        auto inputs = ControlSurfaceManager::getAvailableMIDIInputs();
                        auto outputs = ControlSurfaceManager::getAvailableMIDIOutputs();
                        juce::Array<juce::var> inputArr, outputArr;
                        for (const auto& n : inputs) inputArr.add(n);
                        for (const auto& n : outputs) outputArr.add(n);
                        result->setProperty("inputs", inputArr);
                        result->setProperty("outputs", outputArr);
                        completion(juce::var(result.get()));
                    })
                    // ========== Phase 3.9: Timecode / Sync ==========
                    .withNativeFunction ("connectMIDIClockOutput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString()) {
                            bool ok = audioEngine.getTimecodeSyncManager().getClockOutput().connect(args[0].toString());
                            completion(ok);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setMIDIClockOutputEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            audioEngine.getTimecodeSyncManager().getClockOutput().setEnabled((bool)args[0]);
                        completion(true);
                    })
                    .withNativeFunction ("connectMIDIClockInput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString()) {
                            bool ok = audioEngine.getTimecodeSyncManager().getClockInput().connect(args[0].toString());
                            completion(ok);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setMIDIClockInputEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            audioEngine.getTimecodeSyncManager().getClockInput().setEnabled((bool)args[0]);
                        completion(true);
                    })
                    .withNativeFunction ("connectMTCOutput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString()) {
                            bool ok = audioEngine.getTimecodeSyncManager().getMTCGenerator().connect(args[0].toString());
                            completion(ok);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setMTCEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            audioEngine.getTimecodeSyncManager().getMTCGenerator().setEnabled((bool)args[0]);
                        completion(true);
                    })
                    .withNativeFunction ("setMTCFrameRate", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            int rate = (int)args[0];
                            audioEngine.getTimecodeSyncManager().getMTCGenerator().setFrameRate(static_cast<SMPTEFrameRate>(rate));
                        }
                        completion(true);
                    })
                    .withNativeFunction ("connectMTCInput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString()) {
                            bool ok = audioEngine.getTimecodeSyncManager().getMTCReceiver().connect(args[0].toString());
                            completion(ok);
                        } else { completion(false); }
                    })
                    .withNativeFunction ("setSyncSource", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String src = args[0].toString();
                            if (src == "midi_clock")
                                audioEngine.getTimecodeSyncManager().setSyncSource(TimecodeSyncManager::SyncSource::MIDIClock);
                            else if (src == "mtc")
                                audioEngine.getTimecodeSyncManager().setSyncSource(TimecodeSyncManager::SyncSource::MTC);
                            else
                                audioEngine.getTimecodeSyncManager().setSyncSource(TimecodeSyncManager::SyncSource::Internal);
                        }
                        completion(true);
                    })
                    .withNativeFunction ("getSyncStatus", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        auto* result = new juce::DynamicObject();
                        auto& tsm = audioEngine.getTimecodeSyncManager();
                        result->setProperty("locked", tsm.isSyncLocked());
                        result->setProperty("source", tsm.getSyncSource() == TimecodeSyncManager::SyncSource::Internal ? "internal"
                            : tsm.getSyncSource() == TimecodeSyncManager::SyncSource::MIDIClock ? "midi_clock" : "mtc");
                        result->setProperty("externalBPM", tsm.getClockInput().getExternalBPM());
                        result->setProperty("mtcPosition", tsm.getMTCReceiver().getCurrentPosition());
                        completion(juce::var(result));
                    })
                    // ========== Phase 3.10.2: MCU (Mackie Control Universal) ==========
                    .withNativeFunction ("connectMCU", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2 && args[0].isString() && args[1].isString()) {
                            bool ok = audioEngine.getControlSurfaceManager().getMCUControl().connect(
                                args[0].toString(), args[1].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("disconnectMCU", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getControlSurfaceManager().getMCUControl().disconnect();
                        completion(true);
                    })
                    .withNativeFunction ("setMCUBankOffset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            int offset = (int)args[0];
                            audioEngine.getControlSurfaceManager().getMCUControl().setBankOffset(offset);
                        }
                        completion(true);
                    })
                    // ========== Phase 3.12: Strip Silence ==========
                    .withNativeFunction ("detectSilentRegions", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [filePath, thresholdDb, minSilenceMs, minSoundMs, preAttackMs, postReleaseMs]
                        // Returns: array of { startTime, endTime, startSample, endSample }
                        if (args.size() >= 6 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            double thresholdDb = (double)args[1];
                            double minSilenceMs = (double)args[2];
                            double minSoundMs = (double)args[3];
                            double preAttackMs = (double)args[4];
                            double postReleaseMs = (double)args[5];
                            std::thread([this, filePath, thresholdDb, minSilenceMs, minSoundMs, preAttackMs, postReleaseMs,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                auto result = audioEngine.detectSilentRegions(filePath, thresholdDb, minSilenceMs, minSoundMs, preAttackMs, postReleaseMs);
                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(result);
                                });
                            }).detach();
                        } else {
                            completion(juce::Array<juce::var>());
                        }
                    })
                    // ========== Phase 3.13: Freeze Track ==========
                    .withNativeFunction ("freezeTrack", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [trackId] -> returns { success, filePath, duration, sampleRate, startTime }
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String trackId = args[0].toString();
                            std::thread([this, trackId,
                                         completion = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(completion))]() {
                                const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                                auto result = audioEngine.freezeTrack(trackId);
                                juce::MessageManager::callAsync([completion, result]() {
                                    (*completion)(result);
                                });
                            }).detach();
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("unfreezeTrack", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [trackId] -> returns bool
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String trackId = args[0].toString();
                            bool ok = audioEngine.unfreezeTrack(trackId);
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    // ========== Phase 4.3: Built-in Effects ==========
                    .withNativeFunction ("addTrackBuiltInFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [trackId, effectName, isInputFX?]
                        if (args.size() >= 2 && args[0].isString() && args[1].isString()) {
                            bool isInputFX = args.size() >= 3 && (bool)args[2];
                            const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                            invalidateNAMRackTopology();
                            bool ok = audioEngine.addTrackBuiltInFX(args[0].toString(), args[1].toString(), isInputFX);
                            completion(juce::var(ok));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("addMasterBuiltInFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [effectName]
                        if (args.size() >= 1 && args[0].isString()) {
                            const juce::ScopedLock processMutationLock(namModelMutationStateLock);
                            invalidateNAMRackTopology();
                            bool ok = audioEngine.addMasterBuiltInFX(args[0].toString());
                            completion(juce::var(ok));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("getAvailableBuiltInFX", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getAvailableBuiltInFX());
                    })
                    // ========== Phase 3.14: Session Interchange (AAF/RPP/EDL) ==========
                    .withNativeFunction ("importSession", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [filePath] -> returns session data as JSON or error
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            juce::File file(filePath);
                            auto& si = audioEngine.getSessionInterchange();

                            SessionData data;
                            if (file.getFileExtension().equalsIgnoreCase(".rpp"))
                                data = si.importRPP(file);
                            else if (file.getFileExtension().equalsIgnoreCase(".aaf"))
                                data = si.importAAF(file);
                            else
                                data.error = "Unsupported format: " + file.getFileExtension();

                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            if (data.error.isEmpty()) {
                                result->setProperty("success", true);
                                result->setProperty("tempo", data.tempo);
                                result->setProperty("sampleRate", data.sampleRate);
                                juce::Array<juce::var> tracksArr;
                                for (auto& t : data.tracks) {
                                    juce::DynamicObject::Ptr tObj = new juce::DynamicObject();
                                    tObj->setProperty("name", t.name);
                                    tObj->setProperty("volumeDB", (double)t.volumeDB);
                                    tObj->setProperty("pan", (double)t.pan);
                                    tObj->setProperty("muted", t.muted);
                                    tObj->setProperty("soloed", t.soloed);
                                    juce::Array<juce::var> clipsArr;
                                    for (auto& c : t.clips) {
                                        juce::DynamicObject::Ptr cObj = new juce::DynamicObject();
                                        cObj->setProperty("filePath", c.filePath);
                                        cObj->setProperty("position", c.position);
                                        cObj->setProperty("length", c.length);
                                        cObj->setProperty("offset", c.offset);
                                        cObj->setProperty("volumeDB", (double)c.volumeDB);
                                        clipsArr.add(juce::var(cObj.get()));
                                    }
                                    tObj->setProperty("clips", clipsArr);
                                    tracksArr.add(juce::var(tObj.get()));
                                }
                                result->setProperty("tracks", tracksArr);
                            } else {
                                result->setProperty("success", false);
                                result->setProperty("error", data.error);
                            }
                            completion(juce::var(result.get()));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("exportSession", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [filePath, format, sessionJSON]
                        // format: "rpp" or "edl"
                        if (args.size() >= 3 && args[0].isString() && args[1].isString() && args[2].isObject()) {
                            juce::String filePath = args[0].toString();
                            juce::String format = args[1].toString();
                            auto* sessionObj = args[2].getDynamicObject();

                            SessionData data;
                            if (sessionObj) {
                                data.tempo = (double)sessionObj->getProperty("tempo");
                                data.sampleRate = (double)sessionObj->getProperty("sampleRate");
                                if (auto* tracksArr = sessionObj->getProperty("tracks").getArray()) {
                                    for (auto& tVar : *tracksArr) {
                                        if (auto* tObj = tVar.getDynamicObject()) {
                                            SessionTrack track;
                                            track.name = tObj->getProperty("name").toString();
                                            track.volumeDB = (float)(double)tObj->getProperty("volumeDB");
                                            track.pan = (float)(double)tObj->getProperty("pan");
                                            track.muted = (bool)tObj->getProperty("muted");
                                            track.soloed = (bool)tObj->getProperty("soloed");
                                            if (auto* clipsArr = tObj->getProperty("clips").getArray()) {
                                                for (auto& cVar : *clipsArr) {
                                                    if (auto* cObj = cVar.getDynamicObject()) {
                                                        SessionClip clip;
                                                        clip.filePath = cObj->getProperty("filePath").toString();
                                                        clip.position = (double)cObj->getProperty("position");
                                                        clip.length = (double)cObj->getProperty("length");
                                                        clip.offset = (double)cObj->getProperty("offset");
                                                        clip.volumeDB = (float)(double)cObj->getProperty("volumeDB");
                                                        track.clips.push_back(clip);
                                                    }
                                                }
                                            }
                                            data.tracks.push_back(track);
                                        }
                                    }
                                }
                            }

                            auto& si = audioEngine.getSessionInterchange();
                            bool ok = false;
                            if (format == "rpp")
                                ok = si.exportRPP(juce::File(filePath), data);
                            else if (format == "edl")
                                ok = si.exportEDL(juce::File(filePath), data);

                            completion(juce::var(ok));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    // ========== Phase 4.1: Clip Launch / Trigger ==========
                    .withNativeFunction ("triggerSlot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            audioEngine.getTriggerEngine().triggerSlot((int)args[0], (int)args[1]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("stopSlot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            audioEngine.getTriggerEngine().stopSlot((int)args[0], (int)args[1]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("triggerScene", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            audioEngine.getTriggerEngine().triggerScene((int)args[0]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("stopAllSlots", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getTriggerEngine().stopAll();
                        completion(juce::var(true));
                    })
                    .withNativeFunction ("setSlotClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [trackIndex, slotIndex, filePath, duration]
                        if (args.size() >= 4 && args[2].isString()) {
                            audioEngine.getTriggerEngine().setSlotClip((int)args[0], (int)args[1],
                                args[2].toString(), (double)args[3]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("clearSlot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            audioEngine.getTriggerEngine().clearSlot((int)args[0], (int)args[1]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("getClipLauncherState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getTriggerEngine().getGridState());
                    })
                    // ========== Phase 4.4: Sidechain Routing ==========
                    .withNativeFunction ("setSidechainSource", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [destTrackId, pluginIndex, sourceTrackId]
                        if (args.size() >= 3 && args[0].isString() && args[2].isString()) {
                            audioEngine.setSidechainSource(args[0].toString(), (int)args[1], args[2].toString());
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("clearSidechainSource", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [destTrackId, pluginIndex]
                        if (args.size() >= 2 && args[0].isString()) {
                            audioEngine.clearSidechainSource(args[0].toString(), (int)args[1]);
                            completion(juce::var(true));
                        } else {
                            completion(juce::var(false));
                        }
                    })
                    .withNativeFunction ("getSidechainSource", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [destTrackId, pluginIndex] -> returns sourceTrackId
                        if (args.size() >= 2 && args[0].isString()) {
                            juce::String src = audioEngine.getSidechainSource(args[0].toString(), (int)args[1]);
                            completion(juce::var(src));
                        } else {
                            completion(juce::var(""));
                        }
                    })
                    // ========== Phase 3.7: Surround / Spatial Audio ==========
                    .withNativeFunction ("getSurroundLayouts", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        juce::Array<juce::var> layouts;
                        auto addLayout = [&](const juce::String& name, int channels) {
                            juce::DynamicObject::Ptr obj = new juce::DynamicObject();
                            obj->setProperty("name", name);
                            obj->setProperty("channels", channels);
                            layouts.add(juce::var(obj.get()));
                        };
                        addLayout("Stereo", 2);
                        addLayout("Quad", 4);
                        addLayout("5.1 Surround", 6);
                        addLayout("7.1 Surround", 8);
                        addLayout("7.1.4 Atmos", 12);
                        completion(juce::var(layouts));
                    })
                    // ========== Phase 15: Video, Scripting, LTC ==========
                    .withNativeFunction ("openVideoFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [filePath] -> returns JSON with width, height, duration, fps, audioPath
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String filePath = args[0].toString();
                            juce::File audioDir = juce::File(filePath).getParentDirectory();

                            auto& vr = audioEngine.getVideoReader();
                            bool ok = vr.openFile(filePath, audioDir);

                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            if (ok) {
                                auto& info = vr.getInfo();
                                result->setProperty("width", info.width);
                                result->setProperty("height", info.height);
                                result->setProperty("duration", info.duration);
                                result->setProperty("fps", info.fps);
                                result->setProperty("filePath", info.filePath);
                                result->setProperty("audioPath", info.audioPath);
                            } else {
                                result->setProperty("error", "Failed to open video file");
                            }
                            completion(juce::var(result.get()));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("getVideoFrame", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [time, width?, height?] -> returns base64-encoded JPEG frame
                        if (args.size() >= 1) {
                            double timePos = (double)args[0];
                            int w = args.size() >= 2 ? (int)args[1] : 320;
                            int h = args.size() >= 3 ? (int)args[2] : 180;
                            juce::String frame = audioEngine.getVideoReader().getFrameAtTime(timePos, w, h);
                            completion(juce::var(frame));
                        } else {
                            completion(juce::String(""));
                        }
                    })
                    .withNativeFunction ("closeVideoFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.getVideoReader().closeFile();
                        completion(juce::var(true));
                    })
                    .withNativeFunction ("executeScript", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [code] -> returns JSON { result, error }
                        // Stub implementation — scripting engine not yet integrated
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String code = args[0].toString();
                            juce::Logger::writeToLog("executeScript (stub): " + code.substring(0, 100));

                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("result", juce::String("Not implemented"));
                            result->setProperty("error", juce::String(""));

                            completion(juce::var(result.get()));
                        } else {
                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("result", juce::String(""));
                            result->setProperty("error", juce::String("No code provided"));

                            completion(juce::var(result.get()));
                        }
                    })
                    .withNativeFunction ("loadScriptFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [filePath] -> loads and executes a script file
                        // Stub implementation — scripting engine not yet integrated
                        if (args.size() >= 1 && args[0].isString()) {
                            juce::String scriptPath = args[0].toString();
                            juce::Logger::writeToLog("loadScriptFile (stub): " + scriptPath);

                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("result", juce::String("Not implemented"));
                            result->setProperty("error", juce::String(""));

                            completion(juce::var(result.get()));
                        } else {
                            juce::DynamicObject::Ptr result = new juce::DynamicObject();
                            result->setProperty("result", juce::String(""));
                            result->setProperty("error", juce::String("No file path provided"));

                            completion(juce::var(result.get()));
                        }
                    })
                    .withNativeFunction ("setLTCOutput", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [enabled, channel, frameRate] -> configures SMPTE LTC output
                        // Stub implementation — LTC generation not yet integrated
                        bool enabled = false;
                        int channel = 0;
                        double frameRate = 30.0;

                        if (args.size() >= 1)
                            enabled = (bool)args[0];
                        if (args.size() >= 2)
                            channel = (int)args[1];
                        if (args.size() >= 3)
                            frameRate = (double)args[2];

                        juce::Logger::writeToLog("setLTCOutput (stub): enabled=" + juce::String(enabled ? "true" : "false")
                            + " channel=" + juce::String(channel)
                            + " frameRate=" + juce::String(frameRate));

                        juce::DynamicObject::Ptr result = new juce::DynamicObject();
                        result->setProperty("enabled", enabled);
                        result->setProperty("channel", channel);
                        result->setProperty("frameRate", frameRate);
                        result->setProperty("stub", true);

                        completion(juce::var(result.get()));
                    })
                    // ===== Phase 16: Pro Audio & Compatibility =====
                    .withNativeFunction ("startLiveCapture", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        // Args: [format] -> starts capturing master output to file
                        // Stub implementation — live capture not yet integrated
                        juce::String format = "wav";
                        if (args.size() >= 1 && args[0].isString())
                            format = args[0].toString();

                        juce::String filePath = juce::File::getSpecialLocation(juce::File::tempDirectory)
                            .getChildFile("live_capture_" + juce::String(juce::Time::currentTimeMillis()) + "." + format)
                            .getFullPathName();

                        juce::Logger::writeToLog("startLiveCapture (stub): format=" + format + " path=" + filePath);

                        completion(juce::var(filePath));
                    })
                    .withNativeFunction ("stopLiveCapture", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        juce::ignoreUnused(args);
                        // Stub implementation — returns mock capture result
                        juce::Logger::writeToLog("stopLiveCapture (stub)");

                        juce::DynamicObject::Ptr result = new juce::DynamicObject();
                        result->setProperty("filePath", "");
                        result->setProperty("duration", 0.0);
                        result->setProperty("stub", true);

                        completion(juce::var(result.get()));
                    })
                    .withNativeFunction ("exportDDP", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        // Args: [sourceWavPath, outputDir, tracksJSON, catalogNumber?]
                        // tracksJSON: array of { startTime, endTime, title, isrc }
                        if (args.size() >= 3 && args[0].isString() && args[1].isString() && args[2].isArray()) {
                            juce::String sourceWavPath = args[0].toString();
                            juce::String outputDirPath = args[1].toString();
                            juce::String catalogNumber = args.size() >= 4 ? args[3].toString() : "";

                            std::vector<DDPExporter::CDTrack> tracks;
                            auto* arr = args[2].getArray();
                            for (int i = 0; i < arr->size(); ++i) {
                                auto& item = arr->getReference(i);
                                DDPExporter::CDTrack t;
                                if (auto* obj = item.getDynamicObject()) {
                                    t.startTime = (double)obj->getProperty("startTime");
                                    t.endTime   = (double)obj->getProperty("endTime");
                                    t.title     = obj->getProperty("title").toString();
                                    t.isrc      = obj->getProperty("isrc").toString();
                                } else {
                                    t.startTime = 0.0;
                                    t.endTime   = 0.0;
                                }
                                tracks.push_back(t);
                            }

                            bool ok = audioEngine.getDDPExporter().exportDDP(
                                juce::File(sourceWavPath), juce::File(outputDirPath), tracks, catalogNumber);

                            if (!ok) {
                                juce::Logger::writeToLog("exportDDP failed: " + audioEngine.getDDPExporter().getLastError());
                            }
                            completion(juce::var(ok));
                        } else {
                            juce::Logger::writeToLog("exportDDP: invalid arguments");
                            completion(juce::var(false));
                        }
                    })

                    // ==================== Window Management ====================
                    .withNativeFunction ("minimizeWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(this);
                        juce::ignoreUnused(args);
                       #if JUCE_WINDOWS
                        if (auto* peer = getTopLevelComponent()->getPeer())
                        {
                            auto hwnd = static_cast<HWND> (peer->getNativeHandle());
                            ::ShowWindow (hwnd, SW_MINIMIZE);
                        }
                       #endif
                        completion(juce::var());
                    })
                   .withNativeFunction ("maximizeWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        const bool isNowMaximized = toggleDesktopPseudoMaximize();
                        completion(juce::var(isNowMaximized));
                    })
                    .withNativeFunction ("closeWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(juce::var());
                        if (isMainWindow())
                        {
                            requestFrontendAppClose();
                        }
                        else if (windowRole == WindowRole::midiEditor && windowCallbacks.closeMidiEditorWindow)
                        {
                            auto closeMidiEditorWindow = windowCallbacks.closeMidiEditorWindow;
                            const auto sessionId = windowInstanceId.isNotEmpty() ? windowInstanceId : juce::String("default-midi-editor");
                            juce::MessageManager::callAsync([closeMidiEditorWindow, sessionId]()
                            {
                                closeMidiEditorWindow(sessionId, "close");
                            });
                        }
                        else if (windowRole == WindowRole::pluginEditor && windowCallbacks.closePluginEditorWindow)
                        {
                            auto closePluginEditorWindow = windowCallbacks.closePluginEditorWindow;
                            const auto sessionId = windowInstanceId.isNotEmpty() ? windowInstanceId : juce::String("default-plugin-editor");
                            juce::MessageManager::callAsync([closePluginEditorWindow, sessionId]()
                            {
                                closePluginEditorWindow(sessionId, "close");
                            });
                        }
                        else if (windowCallbacks.closeMixerWindow)
                        {
                            auto closeMixerWindow = windowCallbacks.closeMixerWindow;
                            juce::MessageManager::callAsync([closeMixerWindow]()
                            {
                                closeMixerWindow();
                            });
                        }
                    })
                    .withNativeFunction ("quitApplication", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(juce::var());
                        if (isMainWindow())
                        {
                            if (windowCallbacks.requestAppClose)
                                windowCallbacks.requestAppClose();
                            else
                                juce::JUCEApplication::getInstance()->systemRequestedQuit();
                        }
                    })
                    .withNativeFunction ("isWindowMaximized", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        const bool maximized = isWindowPseudoMaximized();
                        completion(juce::var(maximized));
                    })
                    .withNativeFunction ("startWindowDrag", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        startDesktopWindowDrag();
                        completion(juce::var());
                    })
                    .withNativeFunction ("openMixerWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::var bounds;
                        if (args.size() > 0)
                            bounds = args[0];

                        const bool opened = windowCallbacks.openMixerWindow ? windowCallbacks.openMixerWindow(bounds) : false;
                        completion(juce::var(opened));
                    })
                    .withNativeFunction ("closeMixerWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        auto closeMixerWindow = windowCallbacks.closeMixerWindow;
                        completion(juce::var(static_cast<bool>(closeMixerWindow)));
                        if (closeMixerWindow)
                        {
                            juce::MessageManager::callAsync([closeMixerWindow]()
                            {
                                closeMixerWindow();
                            });
                        }
                    })
                    .withNativeFunction ("getMixerWindowState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        if (windowCallbacks.getMixerWindowState)
                            completion(windowCallbacks.getMixerWindowState());
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("publishMixerUISnapshot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() > 0 && windowCallbacks.publishMixerUISnapshot)
                            windowCallbacks.publishMixerUISnapshot(args[0]);
                        completion(juce::var(true));
                    })
                    .withNativeFunction ("getMixerUISnapshot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        if (windowCallbacks.getMixerUISnapshot)
                            completion(windowCallbacks.getMixerUISnapshot());
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("openMidiEditorWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::String sessionId = windowInstanceId;
                        juce::var bounds;
                        if (args.size() > 0 && args[0].isString())
                            sessionId = args[0].toString();
                        if (args.size() > 1)
                            bounds = args[1];
                        else if (args.size() > 0 && ! args[0].isString())
                            bounds = args[0];
                        if (sessionId.isEmpty())
                            sessionId = "default-midi-editor";

                        const bool opened = windowCallbacks.openMidiEditorWindow ? windowCallbacks.openMidiEditorWindow(sessionId, bounds) : false;
                        completion(juce::var(opened));
                    })
                    .withNativeFunction ("prewarmMidiEditorWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::String sessionId = windowInstanceId;
                        juce::var bounds;
                        if (args.size() > 0 && args[0].isString())
                            sessionId = args[0].toString();
                        if (args.size() > 1)
                            bounds = args[1];
                        else if (args.size() > 0 && ! args[0].isString())
                            bounds = args[0];
                        if (sessionId.isEmpty())
                            sessionId = "default-midi-editor";

                        const bool warmed = windowCallbacks.prewarmMidiEditorWindow ? windowCallbacks.prewarmMidiEditorWindow(sessionId, bounds) : false;
                        completion(juce::var(warmed));
                    })
                    .withNativeFunction ("focusMidiEditorWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::String sessionId = args.size() > 0 && args[0].isString() ? args[0].toString() : windowInstanceId;
                        if (sessionId.isEmpty())
                            sessionId = "default-midi-editor";

                        const bool focused = windowCallbacks.focusMidiEditorWindow ? windowCallbacks.focusMidiEditorWindow(sessionId) : false;
                        completion(juce::var(focused));
                    })
                    .withNativeFunction ("closeMidiEditorWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::String sessionId = args.size() > 0 && args[0].isString() ? args[0].toString() : windowInstanceId;
                        juce::String reason = args.size() > 1 && args[1].isString() ? args[1].toString() : "close";
                        if (sessionId.isEmpty())
                            sessionId = "default-midi-editor";

                        const bool canClose = static_cast<bool>(windowCallbacks.closeMidiEditorWindow);
                        completion(juce::var(canClose));
                        if (canClose)
                        {
                            auto callback = windowCallbacks.closeMidiEditorWindow;
                            juce::MessageManager::callAsync([callback, sessionId, reason]()
                            {
                                callback(sessionId, reason);
                            });
                        }
                    })
                    .withNativeFunction ("getMidiEditorWindowState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::String sessionId = args.size() > 0 && args[0].isString() ? args[0].toString() : windowInstanceId;
                        if (sessionId.isEmpty())
                            sessionId = "default-midi-editor";
                        if (windowCallbacks.getMidiEditorWindowState)
                            completion(windowCallbacks.getMidiEditorWindowState(sessionId));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("publishMidiEditorUISnapshot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() > 1 && args[0].isString() && windowCallbacks.publishMidiEditorUISnapshot)
                            windowCallbacks.publishMidiEditorUISnapshot(args[0].toString(), args[1]);
                        else if (args.size() > 0 && windowCallbacks.publishMidiEditorUISnapshot)
                            windowCallbacks.publishMidiEditorUISnapshot(windowInstanceId.isNotEmpty() ? windowInstanceId : "default-midi-editor", args[0]);
                        completion(juce::var(true));
                    })
                    .withNativeFunction ("getMidiEditorUISnapshot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::String sessionId = args.size() > 0 && args[0].isString() ? args[0].toString() : windowInstanceId;
                        if (sessionId.isEmpty())
                            sessionId = "default-midi-editor";
                        if (windowCallbacks.getMidiEditorUISnapshot)
                            completion(windowCallbacks.getMidiEditorUISnapshot(sessionId));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("openBuiltInPluginEditorWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::String sessionId = windowInstanceId;
                        juce::var bounds;
                        if (args.size() > 0 && args[0].isString())
                            sessionId = args[0].toString();
                        if (args.size() > 1)
                            bounds = args[1];
                        if (sessionId.isEmpty())
                            sessionId = "default-plugin-editor";

                        const bool opened = windowCallbacks.openPluginEditorWindow ? windowCallbacks.openPluginEditorWindow(sessionId, bounds) : false;
                        completion(juce::var(opened));
                    })
                    .withNativeFunction ("closeBuiltInPluginEditorWindow", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::String sessionId = args.size() > 0 && args[0].isString() ? args[0].toString() : windowInstanceId;
                        juce::String reason = args.size() > 1 && args[1].isString() ? args[1].toString() : "close";
                        if (sessionId.isEmpty())
                            sessionId = "default-plugin-editor";

                        const bool canClose = static_cast<bool>(windowCallbacks.closePluginEditorWindow);
                        completion(juce::var(canClose));
                        if (canClose)
                        {
                            auto callback = windowCallbacks.closePluginEditorWindow;
                            juce::MessageManager::callAsync([callback, sessionId, reason]()
                            {
                                callback(sessionId, reason);
                            });
                        }
                    })
                    .withNativeFunction ("publishAppCommand", [] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const juce::var payload = args.size() > 0 ? args[0] : juce::var();
                        MainComponent::broadcastEventToRole(MainComponent::WindowRole::main, "appCommand", payload);
                        completion(juce::var(true));
                    })
                    // ========== Automation (Phase 1.1) ==========
                    .withNativeFunction ("setAutomationPoints", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setAutomationPoints(args[0].toString(), args[1].toString(), args[2].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("replaceAutomationPointsInRange", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 5) {
                            audioEngine.replaceAutomationPointsInRange(args[0].toString(),
                                                                       args[1].toString(),
                                                                       static_cast<double>(args[2]),
                                                                       static_cast<double>(args[3]),
                                                                       args[4].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("setAutomationMode", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 3) {
                            audioEngine.setAutomationMode(args[0].toString(), args[1].toString(), args[2].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getAutomationMode", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            auto mode = audioEngine.getAutomationMode(args[0].toString(), args[1].toString());
                            completion(juce::var(mode));
                        } else {
                            completion(juce::var("off"));
                        }
                    })
                    .withNativeFunction ("clearAutomation", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.clearAutomation(args[0].toString(), args[1].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("beginTouchAutomation", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.beginTouchAutomation(args[0].toString(), args[1].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("endTouchAutomation", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2) {
                            audioEngine.endTouchAutomation(args[0].toString(), args[1].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    // Tempo Map (Phase 1.2)
                    .withNativeFunction ("setTempoMarkers", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 1) {
                            audioEngine.setTempoMarkers(args[0].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("clearTempoMarkers", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.clearTempoMarkers();
                        completion(true);
                    })
                    .withNativeFunction ("setPanLaw", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            audioEngine.setPanLaw(args[0].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getPanLaw", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getPanLaw());
                    })
                    .withNativeFunction ("setTrackDCOffset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            audioEngine.setTrackDCOffset(args[0].toString(), (bool)args[1]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getTrackDCOffset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(args.size() >= 1
                            ? audioEngine.getTrackDCOffset(args[0].toString())
                            : false);
                    })
                    // Clip Gain Envelope (Phase 18.10)
                    .withNativeFunction ("setClipGainEnvelope", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3) {
                            audioEngine.setClipGainEnvelope(args[0].toString(), args[1].toString(), args[2].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    // MIDI Learn (Phase 19.7)
                    .withNativeFunction ("startMIDILearnForPlugin", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3) {
                            const bool isInputFX = args.size() > 3 && static_cast<bool>(args[3]);
                            audioEngine.startMIDILearnForPlugin(args[0].toString(), static_cast<int>(args[1]), static_cast<int>(args[2]), isInputFX);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("startBuiltInMIDILearn", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4) {
                            audioEngine.startMIDILearnForBuiltIn(
                                args[0].toString(), args[1].toString(),
                                static_cast<int>(args[2]), args[3].toString());
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("stopMIDILearn", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        audioEngine.stopMIDILearnMode();
                        completion(true);
                    })
                    .withNativeFunction ("clearMIDILearnMapping", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            audioEngine.clearMIDILearnMapping(static_cast<int>(args[0]));
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getMIDILearnMappings", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getMIDILearnMappings());
                    })
                    .withNativeFunction ("setMIDILearnMappings", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(args.size() > 0 && audioEngine.setMIDILearnMappings(args[0]));
                    })
                    // MIDI Import/Export (Phase 19.9)
                    .withNativeFunction ("importMIDIFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1) {
                            completion(audioEngine.importMIDIFile(args[0].toString()));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("exportMIDIFile", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() == 2 && args[0].isString()) {
                            auto tracks = args[1];
                            if (args[1].isString())
                                tracks = juce::JSON::parse(args[1].toString());

                            completion(tracks.isArray()
                                && audioEngine.exportProjectMIDI(args[0].toString(), tracks, 120.0));
                        } else if (args.size() >= 5) {
                            bool ok = audioEngine.exportMIDIFile(
                                args[0].toString(),  // trackId
                                args[1].toString(),  // clipId
                                args[2].toString(),  // eventsJSON
                                args[3].toString(),  // outputPath
                                static_cast<double>(args[4])  // clipTempo
                            );
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("prepareExternalMIDIFileDrag", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        auto* resultObj = new juce::DynamicObject();
                        auto complete = [&completion, resultObj] (bool success, const juce::String& filePath, const juce::String& error = {}) {
                            resultObj->setProperty("success", success);
                            resultObj->setProperty("filePath", filePath);
                            if (error.isNotEmpty())
                                resultObj->setProperty("error", error);
                            completion(juce::var(resultObj));
                        };

                        if (! isMainWindow())
                        {
                            complete(false, {}, "External MIDI drag is only available from the main window.");
                            return;
                        }

                        if (args.size() < 2 || ! args[0].isString())
                        {
                            complete(false, {}, "Missing MIDI export data.");
                            return;
                        }

                        auto tracks = args[1];
                        if (tracks.isString())
                            tracks = juce::JSON::parse(tracks.toString());

                        if (! tracks.isArray())
                        {
                            complete(false, {}, "Invalid MIDI export data.");
                            return;
                        }

                        auto suggestedName = juce::File::createLegalFileName(
                            juce::File(args[0].toString()).getFileNameWithoutExtension());
                        if (suggestedName.isEmpty())
                            suggestedName = "OpenStudio MIDI Clip";

                        auto dragDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                            .getChildFile("OpenStudio")
                            .getChildFile("MIDI Drag Exports");
                        dragDir.createDirectory();

                        auto outputFile = dragDir.getNonexistentChildFile(suggestedName, ".mid", false);
                        const bool ok = audioEngine.exportProjectMIDI(outputFile.getFullPathName(), tracks, 120.0);
                        complete(ok,
                                 ok ? outputFile.getFullPathName() : juce::String(),
                                 ok ? juce::String() : "Failed to export MIDI drag file.");
                    })
                    .withNativeFunction ("beginExternalFileDrag", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (! isMainWindow() || args.size() < 1 || ! args[0].isString())
                        {
                            completion(false);
                            return;
                        }

                        const juce::File file(args[0].toString());
                        if (! file.existsAsFile())
                        {
                            completion(false);
                            return;
                        }

                        juce::StringArray files;
                        files.add(file.getFullPathName());
                        completion(juce::DragAndDropContainer::performExternalDragDropOfFiles(files, false, this));
                    })
                    // Plugin Presets (Phase 19.14)
                    .withNativeFunction ("getPluginPresets", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3) {
                            completion(audioEngine.getPluginPresets(args[0].toString(), static_cast<int>(args[1]), (bool)args[2]));
                        } else {
                            completion(juce::var());
                        }
                    })
                    .withNativeFunction ("loadPluginPreset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4) {
                            const auto trackId = args[0].toString();
                            const auto fxIndex = static_cast<int>(args[1]);
                            const auto isInputFX = static_cast<bool>(args[2]);
                            const auto presetPath = args[3].toString();
                            if (! audioEngine.isNAMRackPlugin(trackId, fxIndex, isInputFX))
                            {
                                completion(audioEngine.loadPluginPreset(
                                    trackId, fxIndex, isInputFX, presetPath));
                                return;
                            }

                            const auto chainType = isInputFX
                                ? juce::String("input") : juce::String("track");
                            std::vector<std::pair<juce::String, juce::uint64>> namMutationRequests;
                            const auto topologyGeneration = beginNAMModelMutationRequests(
                                trackId, chainType, fxIndex,
                                { "pedal", "amp", "cab" }, namMutationRequests);
                            juce::Component::SafePointer<MainComponent> safeThis(this);
                            builtInStateMutationPool.addJob([
                                safeThis, trackId, chainType, fxIndex, isInputFX,
                                presetPath, namMutationRequests, topologyGeneration,
                                completion]() mutable {
                                if (safeThis == nullptr)
                                    return;

                                bool stillCurrent = isNAMRackTopologyCurrent(topologyGeneration);
                                for (const auto& request : namMutationRequests)
                                {
                                    stillCurrent = stillCurrent
                                        && safeThis->isNAMModelMutationRequestCurrent(
                                            trackId, chainType, fxIndex,
                                            request.first, request.second);
                                }
                                if (! stillCurrent)
                                {
                                    juce::MessageManager::callAsync([safeThis, completion]() mutable {
                                        if (safeThis != nullptr)
                                            completion(false);
                                    });
                                    return;
                                }

                                const auto publicationLeaseFactory = [
                                    safeThis, trackId, chainType, fxIndex,
                                    namMutationRequests, topologyGeneration]()
                                {
                                    return safeThis != nullptr
                                        ? safeThis->acquireNAMModelMutationPublicationLease(
                                            trackId, chainType, fxIndex,
                                            namMutationRequests, topologyGeneration)
                                        : std::shared_ptr<void>();
                                };
                                const bool applied = safeThis->audioEngine.loadPluginPreset(
                                    trackId, fxIndex, isInputFX, presetPath,
                                    publicationLeaseFactory);
                                const bool result = applied;
                                juce::MessageManager::callAsync([
                                    safeThis, completion, result]() mutable {
                                    if (safeThis != nullptr)
                                        completion(result);
                                });
                            });
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("savePluginPreset", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 5) {
                            bool ok = audioEngine.savePluginPreset(args[0].toString(), static_cast<int>(args[1]), (bool)args[2], args[3].toString(), args[4].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    // A/B Comparison (Phase 19.16)
                    .withNativeFunction ("storePluginABState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4) {
                            bool ok = audioEngine.storePluginABState(args[0].toString(), static_cast<int>(args[1]), (bool)args[2], args[3].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("loadPluginABState", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4) {
                            const auto trackId = args[0].toString();
                            const auto fxIndex = static_cast<int>(args[1]);
                            const auto isInputFX = static_cast<bool>(args[2]);
                            const auto slot = args[3].toString();
                            if (! audioEngine.isNAMRackPlugin(trackId, fxIndex, isInputFX))
                            {
                                completion(audioEngine.loadPluginABState(
                                    trackId, fxIndex, isInputFX, slot));
                                return;
                            }

                            const auto chainType = isInputFX
                                ? juce::String("input") : juce::String("track");
                            std::vector<std::pair<juce::String, juce::uint64>> namMutationRequests;
                            const auto topologyGeneration = beginNAMModelMutationRequests(
                                trackId, chainType, fxIndex,
                                { "pedal", "amp", "cab" }, namMutationRequests);
                            juce::Component::SafePointer<MainComponent> safeThis(this);
                            builtInStateMutationPool.addJob([
                                safeThis, trackId, chainType, fxIndex, isInputFX,
                                slot, namMutationRequests, topologyGeneration,
                                completion]() mutable {
                                if (safeThis == nullptr)
                                    return;

                                bool stillCurrent = isNAMRackTopologyCurrent(topologyGeneration);
                                for (const auto& request : namMutationRequests)
                                {
                                    stillCurrent = stillCurrent
                                        && safeThis->isNAMModelMutationRequestCurrent(
                                            trackId, chainType, fxIndex,
                                            request.first, request.second);
                                }
                                if (! stillCurrent)
                                {
                                    juce::MessageManager::callAsync([safeThis, completion]() mutable {
                                        if (safeThis != nullptr)
                                            completion(false);
                                    });
                                    return;
                                }

                                const auto publicationLeaseFactory = [
                                    safeThis, trackId, chainType, fxIndex,
                                    namMutationRequests, topologyGeneration]()
                                {
                                    return safeThis != nullptr
                                        ? safeThis->acquireNAMModelMutationPublicationLease(
                                            trackId, chainType, fxIndex,
                                            namMutationRequests, topologyGeneration)
                                        : std::shared_ptr<void>();
                                };
                                const bool applied = safeThis->audioEngine.loadPluginABState(
                                    trackId, fxIndex, isInputFX, slot,
                                    publicationLeaseFactory);
                                const bool result = applied;
                                juce::MessageManager::callAsync([
                                    safeThis, completion, result]() mutable {
                                    if (safeThis != nullptr)
                                        completion(result);
                                });
                            });
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getPluginActiveSlot", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3) {
                            completion(audioEngine.getPluginActiveSlot(args[0].toString(), static_cast<int>(args[1]), (bool)args[2]));
                        } else {
                            completion(juce::String("A"));
                        }
                    })
                    // Session Archive (Phase 20.5)
                    .withNativeFunction ("archiveSession", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            bool ok = audioEngine.archiveSession(args[0].toString(), args[1].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("unarchiveSession", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            bool ok = audioEngine.unarchiveSession(args[0].toString(), args[1].toString());
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    // Phase Correlation Meter (Phase 20.10)
                    .withNativeFunction ("getPhaseCorrelation", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(static_cast<double>(audioEngine.getPhaseCorrelation()));
                    })
                    // Spectrum Analyzer (Phase 20.11)
                    .withNativeFunction ("getSpectrumData", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        juce::ignoreUnused(args);
                        completion(audioEngine.getSpectrumData());
                    })
                    // Built-in FX Oversampling (Phase 20.12)
                    .withNativeFunction ("setBuiltInFXOversampling", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4) {
                            bool ok = audioEngine.setBuiltInFXOversampling(
                                args[0].toString(),            // trackId
                                static_cast<int>(args[1]),     // fxIndex
                                (bool)args[2],                 // isInputFX
                                (bool)args[3]                  // enabled
                            );
                            completion(ok);
                        } else {
                            completion(false);
                        }
                    })
                    // Channel Strip EQ (Phase 19.18)
                    .withNativeFunction ("setChannelStripEQEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            audioEngine.setChannelStripEQEnabled(args[0].toString(), (bool)args[1]);
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getChannelStripEQEnabled", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(args.size() >= 1
                            ? audioEngine.getChannelStripEQEnabled(args[0].toString())
                            : false);
                    })
                    .withNativeFunction ("setChannelStripEQParam", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3) {
                            audioEngine.setChannelStripEQParam(
                                args[0].toString(),
                                static_cast<int>(args[1]),
                                static_cast<float>((double)args[2])
                            );
                            completion(true);
                        } else {
                            completion(false);
                        }
                    })
                    .withNativeFunction ("getChannelStripEQParam", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2) {
                            completion(static_cast<double>(audioEngine.getChannelStripEQParam(
                                args[0].toString(),
                                static_cast<int>(args[1])
                            )));
                        } else {
                            completion(0.0);
                        }
                    })
                    .withNativeFunction ("getPitchCorrectorData", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.getPitchCorrectorData(args[0].toString(), static_cast<int>(args[1])));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("setPitchCorrectorParam", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4)
                        {
                            audioEngine.setPitchCorrectorParam(args[0].toString(), static_cast<int>(args[1]),
                                                               args[2].toString(), static_cast<float>(static_cast<double>(args[3])));
                            completion(true);
                        }
                        else
                            completion(false);
                    })
                    .withNativeFunction ("getPitchHistory", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                            completion(audioEngine.getPitchHistory(args[0].toString(), static_cast<int>(args[1]), static_cast<int>(args[2])));
                        else
                            completion(juce::Array<juce::var>());
                    })
                    .withNativeFunction ("analyzePitchContour", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                        {
                            auto trackId = args[0].toString();
                            auto clipId  = args[1].toString();
                            // Fire-and-forget: start analysis, emit event when done
                            if (pitchNoteHqPriorityActive.load())
                            {
                                auto obj = std::make_unique<juce::DynamicObject>();
                                obj->setProperty ("started", false);
                                obj->setProperty ("deferred", true);
                                obj->setProperty ("error", "Pitch HQ apply in progress");
                                completion (juce::var (obj.release()));
                                return;
                            }
                            if (pitchAnalysisRunning.load())
                            {
                                auto obj = std::make_unique<juce::DynamicObject>();
                                obj->setProperty ("started", false);
                                obj->setProperty ("error", "Analysis already in progress");
                                completion (juce::var (obj.release()));
                                return;
                            }
                            const int analysisGeneration = ++pitchAnalysisGeneration;
                            pitchAnalysisRunning.store (true);
                            auto obj = std::make_unique<juce::DynamicObject>();
                            obj->setProperty ("started", true);
                            completion (juce::var (obj.release()));

                            juce::Component::SafePointer<MainComponent> safeThis(this);
                            pitchAnalysisPool.addJob ([this, safeThis, trackId, clipId, analysisGeneration]() {
                                juce::Logger::writeToLog ("PitchAnalysis: Starting for track=" + trackId + " clip=" + clipId);
                                auto shouldCancelAnalysis = [this, analysisGeneration]()
                                {
                                    return pitchAnalysisGeneration.load() != analysisGeneration
                                        || pitchNoteHqPriorityActive.load();
                                };
                                auto result = audioEngine.analyzePitchContour(trackId, clipId, shouldCancelAnalysis);
                                const bool cancelled = shouldCancelAnalysis();
                                if (pitchAnalysisGeneration.load() == analysisGeneration)
                                    pitchAnalysisRunning.store (false);

                                int noteCount = 0;
                                bool hasResult = false;
                                if (auto* obj = (! cancelled ? result.getDynamicObject() : nullptr))
                                {
                                    auto notesVar = obj->getProperty ("notes");
                                    noteCount = notesVar.isArray() ? notesVar.getArray()->size() : 0;
                                    hasResult = true;
                                    juce::Logger::writeToLog ("PitchAnalysis: Complete — "
                                        + juce::String(noteCount) + " notes detected, clipId=" + clipId);
                                }
                                else
                                {
                                    juce::Logger::writeToLog ("PitchAnalysis: Result is VOID/empty!");
                                }

                                if (! cancelled)
                                {
                                    const juce::ScopedLock sl (pitchResultLock);
                                    lastPitchAnalysisResult = result;
                                }

                                juce::MessageManager::callAsync ([safeThis, clipId, noteCount, hasResult, cancelled]() {
                                    if (safeThis == nullptr || safeThis->secondaryWindowClosing)
                                        return;

                                    auto notification = std::make_unique<juce::DynamicObject>();
                                    notification->setProperty ("clipId", clipId);
                                    notification->setProperty ("noteCount", noteCount);
                                    notification->setProperty ("ready", hasResult && ! cancelled);
                                    notification->setProperty ("cancelled", cancelled);
                                    juce::Logger::writeToLog ("PitchAnalysis: Emitting lightweight event (noteCount="
                                        + juce::String(noteCount) + ")");
                                    safeThis->webView.emitEventIfBrowserIsVisible ("pitchAnalysisComplete",
                                        juce::var (notification.release()));
                                });
                            });
                        }
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("analyzePitchContourDirect", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4)
                        {
                            auto filePath = args[0].toString();
                            auto offset   = static_cast<double>(args[1]);
                            auto duration  = static_cast<double>(args[2]);
                            auto clipId    = args[3].toString();
                            // Fire-and-forget: start analysis, emit event when done
                            if (pitchNoteHqPriorityActive.load())
                            {
                                auto obj = std::make_unique<juce::DynamicObject>();
                                obj->setProperty ("started", false);
                                obj->setProperty ("deferred", true);
                                obj->setProperty ("error", "Pitch HQ apply in progress");
                                completion (juce::var (obj.release()));
                                return;
                            }
                            if (pitchAnalysisRunning.load())
                            {
                                auto obj = std::make_unique<juce::DynamicObject>();
                                obj->setProperty ("started", false);
                                obj->setProperty ("error", "Analysis already in progress");
                                completion (juce::var (obj.release()));
                                return;
                            }
                            const int analysisGeneration = ++pitchAnalysisGeneration;
                            pitchAnalysisRunning.store (true);
                            auto obj = std::make_unique<juce::DynamicObject>();
                            obj->setProperty ("started", true);
                            completion (juce::var (obj.release()));

                            juce::Component::SafePointer<MainComponent> safeThis(this);
                            pitchAnalysisPool.addJob ([this, safeThis, filePath, offset, duration, clipId, analysisGeneration]() {
                                juce::Logger::writeToLog ("PitchAnalysis: Starting for " + filePath
                                    + " offset=" + juce::String(offset) + " dur=" + juce::String(duration));
                                auto shouldCancelAnalysis = [this, analysisGeneration]()
                                {
                                    return pitchAnalysisGeneration.load() != analysisGeneration
                                        || pitchNoteHqPriorityActive.load();
                                };
                                auto result = audioEngine.analyzePitchContourDirect(filePath, offset, duration, clipId, shouldCancelAnalysis);
                                const bool cancelled = shouldCancelAnalysis();
                                if (pitchAnalysisGeneration.load() == analysisGeneration)
                                    pitchAnalysisRunning.store (false);

                                int noteCount = 0;
                                bool hasResult = false;
                                if (auto* obj = (! cancelled ? result.getDynamicObject() : nullptr))
                                {
                                    auto notesVar = obj->getProperty ("notes");
                                    noteCount = notesVar.isArray() ? notesVar.getArray()->size() : 0;
                                    hasResult = true;
                                    juce::Logger::writeToLog ("PitchAnalysis: Complete — "
                                        + juce::String(noteCount) + " notes detected, clipId=" + clipId);
                                }
                                else
                                {
                                    juce::Logger::writeToLog ("PitchAnalysis: Result is VOID/empty!");
                                }

                                // Store result for fetch-after-event pattern (avoids large event payload)
                                if (! cancelled)
                                {
                                    const juce::ScopedLock sl (pitchResultLock);
                                    lastPitchAnalysisResult = result;
                                }

                                juce::MessageManager::callAsync ([safeThis, clipId, noteCount, hasResult, cancelled]() {
                                    if (safeThis == nullptr || safeThis->secondaryWindowClosing)
                                        return;

                                    // Send lightweight notification with metadata only
                                    auto notification = std::make_unique<juce::DynamicObject>();
                                    notification->setProperty ("clipId", clipId);
                                    notification->setProperty ("noteCount", noteCount);
                                    notification->setProperty ("ready", hasResult && ! cancelled);
                                    notification->setProperty ("cancelled", cancelled);
                                    juce::Logger::writeToLog ("PitchAnalysis: Emitting lightweight event (noteCount="
                                        + juce::String(noteCount) + ")");
                                    safeThis->webView.emitEventIfBrowserIsVisible ("pitchAnalysisComplete",
                                        juce::var (notification.release()));
                                });
                            });
                        }
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("getLastPitchAnalysisResult", [this] (const juce::Array<juce::var>& /*args*/, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        const juce::ScopedLock sl (pitchResultLock);
                        completion (lastPitchAnalysisResult);
                    })
                    .withNativeFunction ("applyPitchCorrection", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                        {
                            juce::String trackId = args[0].toString();
                            juce::String clipId  = args[1].toString();
                            juce::var    notes   = args[2];
                            juce::var    frames  = (args.size() >= 4) ? args[3] : juce::var();
                            juce::String requestId = (args.size() >= 5) ? args[4].toString() : juce::String();
                            float globalFormantSemitones = (args.size() >= 6)
                                ? static_cast<float> (static_cast<double> (args[5]))
                                : 0.0f;
                            std::optional<double> windowStartSec;
                            std::optional<double> windowEndSec;
                            juce::String renderMode = (args.size() >= 9 && args[8].isString())
                                ? args[8].toString()
                                : "single";
                            juce::String requestGroupId = (args.size() >= 10 && args[9].isString())
                                ? args[9].toString()
                                : requestId;
                            if (args.size() >= 7 && args[6].isDouble())
                                windowStartSec = static_cast<double> (args[6]);
                            if (args.size() >= 8 && args[7].isDouble())
                                windowEndSec = static_cast<double> (args[7]);
                            int noteCount = 0;
                            if (auto* noteArray = notes.getArray())
                                noteCount = noteArray->size();
                            logPitchEditorFormant ("bridge applyPitchCorrection received clip=" + clipId
                                + " requestId=" + requestId
                                + " requestGroupId=" + requestGroupId
                                + " noteCount=" + juce::String (noteCount)
                                + " globalFormantSt=" + juce::String (globalFormantSemitones, 3)
                                + " renderMode=" + renderMode
                                + " windowStart=" + juce::String (windowStartSec.has_value() ? *windowStartSec : -1.0, 3)
                                + " windowEnd=" + juce::String (windowEndSec.has_value() ? *windowEndSec : -1.0, 3));
                            // Return immediately — re-synthesis is expensive (seconds).
                            // Discard any stale queued-but-not-yet-started jobs so they don't
                            // pile up and corrupt the output file with stale note data.
                            // The currently-running job (if any) is allowed to finish safely.
                            const bool isPreviewSegment = renderMode == "preview_segment";
                            const bool isNoteRender = renderMode == "note_hq";
                            if (isNoteRender)
                            {
                                pitchNoteHqPriorityActive.store (true);
                                ++pitchAnalysisGeneration;
                                pitchAnalysisRunning.store (false);
                                pitchAnalysisPool.removeAllJobs (false, 0);
                            }
                            juce::ThreadPool* targetPool = isPreviewSegment
                                ? &previewSegmentPool
                                : (isNoteRender ? &noteRenderPool : &fullClipHQPool);
                            int renderGeneration = 0;
                            {
                                const juce::ScopedLock sl (pitchCorrectionJobLock);
                                if (isPreviewSegment)
                                {
                                    if (activePreviewRequestGroup != requestGroupId)
                                    {
                                        previewSegmentPool.removeAllJobs (false, 0);
                                        activePreviewRequestGroup = requestGroupId;
                                        renderGeneration = ++previewRenderGeneration;
                                        audioEngine.getPlaybackEngine().beginRenderedPreviewSegmentGeneration (clipId, renderGeneration);
                                    }
                                    else
                                    {
                                        renderGeneration = previewRenderGeneration.load();
                                    }
                                }
                                else if (isNoteRender)
                                {
                                    previewSegmentPool.removeAllJobs (false, 0);
                                    activePreviewRequestGroup = {};
                                    ++previewRenderGeneration;
                                    audioEngine.getPlaybackEngine().clearAllPitchPreviewRoutes (clipId);
                                    logPitchEditorFormant ("note_hq invalidated preview routes clip=" + clipId
                                        + " requestId=" + requestId
                                        + " requestGroupId=" + requestGroupId);
                                    if (activeNoteRenderRequestGroup != requestGroupId)
                                    {
                                        noteRenderPool.removeAllJobs (false, 0);
                                        activeNoteRenderRequestGroup = requestGroupId;
                                        renderGeneration = ++noteRenderGeneration;
                                    }
                                    else
                                    {
                                        renderGeneration = noteRenderGeneration.load();
                                    }
                                }
                                else
                                {
                                    if (activeFullClipRequestGroup != requestGroupId)
                                    {
                                        fullClipHQPool.removeAllJobs (false, 0);
                                        activeFullClipRequestGroup = requestGroupId;
                                        renderGeneration = ++fullClipRenderGeneration;
                                    }
                                    else
                                    {
                                        renderGeneration = fullClipRenderGeneration.load();
                                    }
                                }
                            }
                            if (isNoteRender)
                                pitchNoteHqPriorityGeneration.store (renderGeneration);
                            const auto queuedAtMs = juce::Time::currentTimeMillis();
                            completion(true);
                            juce::Component::SafePointer<MainComponent> safeThis(this);
                            targetPool->addJob ([this, safeThis, trackId, clipId, notes, frames, requestId, requestGroupId, globalFormantSemitones, windowStartSec, windowEndSec, renderMode, renderGeneration, isPreviewSegment, isNoteRender, queuedAtMs]() mutable {
                                auto shouldCancel = [this, renderGeneration, requestGroupId, isPreviewSegment, isNoteRender]() {
                                    const juce::ScopedLock sl (pitchCorrectionJobLock);
                                    if (isPreviewSegment)
                                        return previewRenderGeneration.load() != renderGeneration || activePreviewRequestGroup != requestGroupId;
                                    if (isNoteRender)
                                        return noteRenderGeneration.load() != renderGeneration || activeNoteRenderRequestGroup != requestGroupId;
                                    return fullClipRenderGeneration.load() != renderGeneration || activeFullClipRequestGroup != requestGroupId;
                                };
                                auto guardedCommit = [this, renderGeneration, requestGroupId, isPreviewSegment, isNoteRender]
                                    (const std::function<void()>& commit) {
                                        const juce::ScopedLock sl (pitchCorrectionJobLock);
                                        const bool isCurrent = isPreviewSegment
                                            ? previewRenderGeneration.load() == renderGeneration && activePreviewRequestGroup == requestGroupId
                                            : (isNoteRender
                                                ? noteRenderGeneration.load() == renderGeneration && activeNoteRenderRequestGroup == requestGroupId
                                                : fullClipRenderGeneration.load() == renderGeneration && activeFullClipRequestGroup == requestGroupId);
                                        if (! isCurrent)
                                            return false;
                                        commit();
                                        return true;
                                    };
                                logPitchEditorFormant ("job starting clip=" + clipId
                                    + " requestId=" + requestId
                                    + " requestGroupId=" + requestGroupId
                                    + " globalFormantSt=" + juce::String (globalFormantSemitones, 3)
                                    + " renderMode=" + renderMode
                                    + " generation=" + juce::String (renderGeneration));
                                const double jobStartDelayMs = static_cast<double> (juce::Time::currentTimeMillis() - queuedAtMs);
                                auto result = shouldCancel()
                                    ? juce::var()
                                    : audioEngine.applyPitchCorrection(trackId, clipId, notes, frames, globalFormantSemitones, windowStartSec, windowEndSec, renderMode, shouldCancel, jobStartDelayMs, isPreviewSegment ? renderGeneration : 0, guardedCommit);
                                if (isNoteRender && pitchNoteHqPriorityGeneration.load() == renderGeneration)
                                    pitchNoteHqPriorityActive.store (false);
                                bool success = result.isObject()
                                    && static_cast<bool> (result.getProperty ("success", false));
                                juce::String outputFile = (success && result["outputFile"].isString())
                                    ? result["outputFile"].toString() : juce::String();
                                bool restored = result.isObject() && static_cast<bool> (result.getProperty ("restored", false));
                                bool cancelled = result.isObject() && static_cast<bool> (result.getProperty ("cancelled", false));
                                bool swapDeferred = result.isObject() && static_cast<bool> (result.getProperty ("swapDeferred", false));
                                double previewCoverageStartSec = result.isObject() ? static_cast<double> (result.getProperty ("previewCoverageStartSec", 0.0)) : 0.0;
                                double previewCoverageEndSec = result.isObject() ? static_cast<double> (result.getProperty ("previewCoverageEndSec", 0.0)) : 0.0;
                                double candidateCoverageStartSec = result.isObject() ? static_cast<double> (result.getProperty ("candidateCoverageStartSec", 0.0)) : 0.0;
                                double candidateCoverageEndSec = result.isObject() ? static_cast<double> (result.getProperty ("candidateCoverageEndSec", 0.0)) : 0.0;
                                juce::String requestedRendererBranch = result.isObject() ? result.getProperty ("requestedRendererBranch", {}).toString() : juce::String();
                                juce::String actualRendererBranch = result.isObject() ? result.getProperty ("actualRendererBranch", {}).toString() : juce::String();
                                juce::String pitchOnlyRecoveryPath = result.isObject() ? result.getProperty ("pitchOnlyRecoveryPath", {}).toString() : juce::String();
                                bool pitchOnlyNeutralFormantUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyNeutralFormantUsed", false));
                                juce::String processingMode = result.isObject() ? result.getProperty ("processingMode", {}).toString() : juce::String();
                                bool formantCurveUsed = result.isObject() && static_cast<bool> (result.getProperty ("formantCurveUsed", false));
                                bool explicitFormantRequested = result.isObject() && static_cast<bool> (result.getProperty ("explicitFormantRequested", false));
                                bool pitchOnlyFormantSuppressed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyFormantSuppressed", false));
                                bool usedFallback = result.isObject() && static_cast<bool> (result.getProperty ("usedFallback", false));
                                juce::String fallbackReason = result.isObject() ? result.getProperty ("fallbackReason", {}).toString() : juce::String();
                                juce::String hardFailReason = result.isObject() ? result.getProperty ("hardFailReason", {}).toString() : juce::String();
                                juce::String pitchRenderStrategy = result.isObject() ? result.getProperty ("pitchRenderStrategy", {}).toString() : juce::String();
                                bool phraseHqRenderUsed = result.isObject() && static_cast<bool> (result.getProperty ("phraseHqRenderUsed", false));
                                bool phraseHqExpandedToFullClip = result.isObject() && static_cast<bool> (result.getProperty ("phraseHqExpandedToFullClip", false));
                                double phraseHqStartSec = result.isObject() ? static_cast<double> (result.getProperty ("phraseHqStartSec", 0.0)) : 0.0;
                                double phraseHqEndSec = result.isObject() ? static_cast<double> (result.getProperty ("phraseHqEndSec", 0.0)) : 0.0;
                                juce::String pitchRenderProductPath = result.isObject() ? result.getProperty ("pitchRenderProductPath", {}).toString() : juce::String();
                                juce::String pitchRenderBackendId = result.isObject() ? result.getProperty ("pitchRenderBackendId", {}).toString() : juce::String();
                                juce::String pitchRenderBackendVersion = result.isObject() ? result.getProperty ("pitchRenderBackendVersion", {}).toString() : juce::String();
                                juce::String pitchRenderBackendFailureCode = result.isObject() ? result.getProperty ("pitchRenderBackendFailureCode", {}).toString() : juce::String();
                                juce::var pitchRenderBackendCapabilities = result.isObject() ? result.getProperty ("pitchRenderBackendCapabilities", juce::var()) : juce::var();
                                juce::var pitchRenderBackendDiagnostics = result.isObject() ? result.getProperty ("pitchRenderBackendDiagnostics", juce::var()) : juce::var();
                                juce::String pitchRenderCommitPolicy = result.isObject() ? result.getProperty ("pitchRenderCommitPolicy", {}).toString() : juce::String();
                                int pitchRenderDryProtectedSamples = result.isObject() ? static_cast<int> (result.getProperty ("pitchRenderDryProtectedSamples", 0)) : 0;
                                double pitchRenderContextDurationSec = result.isObject() ? static_cast<double> (result.getProperty ("pitchRenderContextDurationSec", 0.0)) : 0.0;
                                double pitchRenderCommitDurationSec = result.isObject() ? static_cast<double> (result.getProperty ("pitchRenderCommitDurationSec", 0.0)) : 0.0;
                                double pitchRenderJobStartDelayMs = result.isObject() ? static_cast<double> (result.getProperty ("pitchRenderJobStartDelayMs", 0.0)) : 0.0;
                                juce::String pitchRenderDirection = result.isObject() ? result.getProperty ("pitchRenderDirection", {}).toString() : juce::String();
                                bool downshiftFormantGuardUsed = result.isObject() && static_cast<bool> (result.getProperty ("downshiftFormantGuardUsed", false));
                                double downshiftFormantGuardAlpha = result.isObject() ? static_cast<double> (result.getProperty ("downshiftFormantGuardAlpha", 0.0)) : 0.0;
                                double noteHqEffectiveStartSec = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEffectiveStartSec", 0.0)) : 0.0;
                                double noteHqEffectiveEndSec = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEffectiveEndSec", 0.0)) : 0.0;
                                double noteHqContextStartSec = result.isObject() ? static_cast<double> (result.getProperty ("noteHqContextStartSec", 0.0)) : 0.0;
                                double noteHqContextEndSec = result.isObject() ? static_cast<double> (result.getProperty ("noteHqContextEndSec", 0.0)) : 0.0;
                                double noteHqAudibleCommitStartSec = result.isObject() ? static_cast<double> (result.getProperty ("noteHqAudibleCommitStartSec", 0.0)) : 0.0;
                                double noteHqAudibleCommitEndSec = result.isObject() ? static_cast<double> (result.getProperty ("noteHqAudibleCommitEndSec", 0.0)) : 0.0;
                                int noteHqPreBodyDryProtectedSamples = result.isObject() ? static_cast<int> (result.getProperty ("noteHqPreBodyDryProtectedSamples", 0)) : 0;
                                double noteHqEntryInsideBodyFadeMs = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEntryInsideBodyFadeMs", 0.0)) : 0.0;
                                double noteHqExitLeadInMs = result.isObject() ? static_cast<double> (result.getProperty ("noteHqExitLeadInMs", 0.0)) : 0.0;
                                double noteHqEntryBridgeStartSec = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEntryBridgeStartSec", 0.0)) : 0.0;
                                double noteHqEntryBridgeEndSec = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEntryBridgeEndSec", 0.0)) : 0.0;
                                double noteHqEntryBridgeWetLagMs = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEntryBridgeWetLagMs", 0.0)) : 0.0;
                                double noteHqEntryBridgeEnvelopeGainDb = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEntryBridgeEnvelopeGainDb", 0.0)) : 0.0;
                                bool noteHqEntryBridgeUsed = result.isObject() && static_cast<bool> (result.getProperty ("noteHqEntryBridgeUsed", false));
                                double noteHqEntryTransientDryPreservedMs = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEntryTransientDryPreservedMs", 0.0)) : 0.0;
                                bool pitchOnlyEntrySimpleHandoffUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyEntrySimpleHandoffUsed", false));
                                bool pitchOnlyEntrySafeHandoffUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyEntrySafeHandoffUsed", false));
                                double pitchOnlyEntryDryHoldMs = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryDryHoldMs", 0.0)) : 0.0;
                                double pitchOnlyEntrySafeBridgeMs = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntrySafeBridgeMs", 0.0)) : 0.0;
                                double pitchOnlyEntryWetAlignmentMs = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryWetAlignmentMs", 0.0)) : 0.0;
                                double pitchOnlyEntryWetGainDb = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryWetGainDb", 0.0)) : 0.0;
                                double pitchOnlyEntryWetVsDryRmsDb = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryWetVsDryRmsDb", 0.0)) : 0.0;
                                bool pitchOnlyEntryEqualPowerBlendUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyEntryEqualPowerBlendUsed", false));
                                bool pitchOnlyEntryRmsContinuityUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyEntryRmsContinuityUsed", false));
                                double pitchOnlyEntryRmsContinuityGainDb = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryRmsContinuityGainDb", 0.0)) : 0.0;
                                double pitchOnlyEntryRmsContinuityMs = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryRmsContinuityMs", 0.0)) : 0.0;
                                bool pitchOnlyEntryPhaseSafeUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyEntryPhaseSafeUsed", false));
                                bool pitchOnlyEntryWetAlignmentAccepted = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyEntryWetAlignmentAccepted", false));
                                double pitchOnlyEntryFirstCycleCorrelation = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryFirstCycleCorrelation", 0.0)) : 0.0;
                                double pitchOnlyEntryZeroCrossOffsetMs = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryZeroCrossOffsetMs", 0.0)) : 0.0;
                                double pitchOnlyEntryBridgeGainRampDb = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryBridgeGainRampDb", 0.0)) : 0.0;
                                bool pitchOnlyDownshiftCoreEnvelopePassUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyDownshiftCoreEnvelopePassUsed", false));
                                double pitchOnlyDownshiftCoreRmsTrimDb = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyDownshiftCoreRmsTrimDb", 0.0)) : 0.0;
                                double pitchOnlyDownshiftCoreEnvelopeMaxDb = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyDownshiftCoreEnvelopeMaxDb", 0.0)) : 0.0;
                                int pitchOnlyDownshiftCoreEnvelopeFrames = result.isObject() ? static_cast<int> (result.getProperty ("pitchOnlyDownshiftCoreEnvelopeFrames", 0)) : 0;
                                double pitchOnlyEntryWetLagMs = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryWetLagMs", 0.0)) : 0.0;
                                double pitchOnlyEntryBridgeDurationMs = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryBridgeDurationMs", 0.0)) : 0.0;
                                bool pitchOnlyExitDryRestoreUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyExitDryRestoreUsed", false));
                                double pitchOnlyExitDryRestoreStartSec = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyExitDryRestoreStartSec", 0.0)) : 0.0;
                                double pitchOnlyExitDryRestoreEndSec = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyExitDryRestoreEndSec", 0.0)) : 0.0;
                                int noteHqEditIslandCount = result.isObject() ? static_cast<int> (result.getProperty ("noteHqEditIslandCount", 0)) : 0;
                                int noteHqEditedNoteCount = result.isObject() ? static_cast<int> (result.getProperty ("noteHqEditedNoteCount", 0)) : 0;
                                bool noteHqEntryPitchHandoffUsed = result.isObject() && static_cast<bool> (result.getProperty ("noteHqEntryPitchHandoffUsed", false));
                                double noteHqEntryPitchHandoffStartSec = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEntryPitchHandoffStartSec", 0.0)) : 0.0;
                                double noteHqEntryPitchHandoffEndSec = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEntryPitchHandoffEndSec", 0.0)) : 0.0;
                                double noteHqEntryPitchHandoffPreMs = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEntryPitchHandoffPreMs", 0.0)) : 0.0;
                                double noteHqEntryPitchHandoffBodyMs = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEntryPitchHandoffBodyMs", 0.0)) : 0.0;
                                double noteHqEntryPitchSlopeJumpStPerSec = result.isObject() ? static_cast<double> (result.getProperty ("noteHqEntryPitchSlopeJumpStPerSec", 0.0)) : 0.0;
                                bool noteHqEntryPitchAccelerationLimited = result.isObject() && static_cast<bool> (result.getProperty ("noteHqEntryPitchAccelerationLimited", false));
                                double outputDurationSec = result.isObject() ? static_cast<double> (result.getProperty ("outputDurationSec", 0.0)) : 0.0;
                                juce::var postApplyRouteStatus = result.isObject() ? result.getProperty ("postApplyRouteStatus", juce::var()) : juce::var();
                                juce::var appFinalCapture = result.isObject() ? result.getProperty ("appFinalCapture", juce::var()) : juce::var();
                                juce::var appFinalBakedCapture = result.isObject() ? result.getProperty ("appFinalBakedCapture", juce::var()) : juce::var();
                                juce::var appFinalParityReport = result.isObject() ? result.getProperty ("appFinalParityReport", juce::var()) : juce::var();
                                juce::String appFinalRouteReportPath = result.isObject() ? result.getProperty ("appFinalRouteReportPath", {}).toString() : juce::String();
                                juce::String appFinalBakedContextPath = result.isObject() ? result.getProperty ("appFinalBakedContextPath", {}).toString() : juce::String();
                                juce::String appFinalPlaybackContextPath = result.isObject() ? result.getProperty ("appFinalPlaybackContextPath", {}).toString() : juce::String();
                                juce::String appFinalParityReportPath = result.isObject() ? result.getProperty ("appFinalParityReportPath", {}).toString() : juce::String();
                                bool bridgeUsed = result.isObject() && static_cast<bool> (result.getProperty ("bridgeUsed", false));
                                bool bridgeFallbackUsed = result.isObject() && static_cast<bool> (result.getProperty ("bridgeFallbackUsed", false));
                                double bridgeStartSec = result.isObject() ? static_cast<double> (result.getProperty ("bridgeStartSec", 0.0)) : 0.0;
                                double bridgeLengthMs = result.isObject() ? static_cast<double> (result.getProperty ("bridgeLengthMs", 0.0)) : 0.0;
                                int bridgeAlignmentLagSamples = result.isObject() ? static_cast<int> (result.getProperty ("bridgeAlignmentLagSamples", 0)) : 0;
                                double bridgeCorrelationScore = result.isObject() ? static_cast<double> (result.getProperty ("bridgeCorrelationScore", 0.0)) : 0.0;
                                double bridgeGainDeltaDb = result.isObject() ? static_cast<double> (result.getProperty ("bridgeGainDeltaDb", 0.0)) : 0.0;
                                bool bodyReplacementUsed = result.isObject() && static_cast<bool> (result.getProperty ("bodyReplacementUsed", false));
                                bool bodyReplacementFallbackUsed = result.isObject() && static_cast<bool> (result.getProperty ("bodyReplacementFallbackUsed", false));
                                double entryLockStartSec = result.isObject() ? static_cast<double> (result.getProperty ("entryLockStartSec", 0.0)) : 0.0;
                                double entryLockLengthMs = result.isObject() ? static_cast<double> (result.getProperty ("entryLockLengthMs", 0.0)) : 0.0;
                                double exitLockStartSec = result.isObject() ? static_cast<double> (result.getProperty ("exitLockStartSec", 0.0)) : 0.0;
                                double renderedBodyStartSec = result.isObject() ? static_cast<double> (result.getProperty ("renderedBodyStartSec", 0.0)) : 0.0;
                                double renderedBodyEndSec = result.isObject() ? static_cast<double> (result.getProperty ("renderedBodyEndSec", 0.0)) : 0.0;
                                bool islandNativeUsed = result.isObject() && static_cast<bool> (result.getProperty ("islandNativeUsed", false));
                                bool islandNativeFallbackUsed = result.isObject() && static_cast<bool> (result.getProperty ("islandNativeFallbackUsed", false));
                                double islandRenderStartSec = result.isObject() ? static_cast<double> (result.getProperty ("islandRenderStartSec", 0.0)) : 0.0;
                                double islandRenderEndSec = result.isObject() ? static_cast<double> (result.getProperty ("islandRenderEndSec", 0.0)) : 0.0;
                                double transientMaskPeak = result.isObject() ? static_cast<double> (result.getProperty ("transientMaskPeak", 0.0)) : 0.0;
                                double voicedCoreMaskPeak = result.isObject() ? static_cast<double> (result.getProperty ("voicedCoreMaskPeak", 0.0)) : 0.0;
                                bool hpssUsed = result.isObject() && static_cast<bool> (result.getProperty ("hpssUsed", false));
                                bool hpssFallbackUsed = result.isObject() && static_cast<bool> (result.getProperty ("hpssFallbackUsed", false));
                                double harmonicMaskPeak = result.isObject() ? static_cast<double> (result.getProperty ("harmonicMaskPeak", 0.0)) : 0.0;
                                double aperiodicMaskPeak = result.isObject() ? static_cast<double> (result.getProperty ("aperiodicMaskPeak", 0.0)) : 0.0;
                                bool spectralEnvelopeCorrectionUsed = result.isObject() && static_cast<bool> (result.getProperty ("spectralEnvelopeCorrectionUsed", false));
                                bool pitchOnlyCoreTimbreCorrectionUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyCoreTimbreCorrectionUsed", false));
                                double pitchOnlyCoreEnvelopeMix = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyCoreEnvelopeMix", 0.0)) : 0.0;
                                double pitchOnlyCoreRmsTrimDb = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyCoreRmsTrimDb", 0.0)) : 0.0;
                                int pitchOnlyCoreEnvelopeLifter = result.isObject() ? static_cast<int> (result.getProperty ("pitchOnlyCoreEnvelopeLifter", 0)) : 0;
                                bool pitchOnlyEntryTimbreCorrectionUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyEntryTimbreCorrectionUsed", false));
                                double pitchOnlyEntryRmsTrimDb = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryRmsTrimDb", 0.0)) : 0.0;
                                double pitchOnlyEntryTiltDb = result.isObject() ? static_cast<double> (result.getProperty ("pitchOnlyEntryTiltDb", 0.0)) : 0.0;
                                bool pitchOnlyEntryHandoffUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyEntryHandoffUsed", false));
                                bool pitchOnlyExitHandoffUsed = result.isObject() && static_cast<bool> (result.getProperty ("pitchOnlyExitHandoffUsed", false));
                                bool vocalSourceFilterUsed = result.isObject() && static_cast<bool> (result.getProperty ("vocalSourceFilterUsed", false));
                                double vocalSourceFilterVoicedCoverage = result.isObject() ? static_cast<double> (result.getProperty ("vocalSourceFilterVoicedCoverage", 0.0)) : 0.0;
                                double vocalSourceFilterResidualMix = result.isObject() ? static_cast<double> (result.getProperty ("vocalSourceFilterResidualMix", 0.0)) : 0.0;
                                bool vocalSourceFilterFallbackUsed = result.isObject() && static_cast<bool> (result.getProperty ("vocalSourceFilterFallbackUsed", false));
                                juce::String vocalSourceFilterFallbackReason = result.isObject() ? result.getProperty ("vocalSourceFilterFallbackReason", {}).toString() : juce::String();
                                double vocalSourceFilterEntryDryMs = result.isObject() ? static_cast<double> (result.getProperty ("vocalSourceFilterEntryDryMs", 0.0)) : 0.0;
                                double vocalSourceFilterExitDryMs = result.isObject() ? static_cast<double> (result.getProperty ("vocalSourceFilterExitDryMs", 0.0)) : 0.0;
                                bool wsolaUsed = result.isObject() && static_cast<bool> (result.getProperty ("wsolaUsed", false));
                                bool wsolaFallbackUsed = result.isObject() && static_cast<bool> (result.getProperty ("wsolaFallbackUsed", false));
                                int wsolaEntryLagSamples = result.isObject() ? static_cast<int> (result.getProperty ("wsolaEntryLagSamples", 0)) : 0;
                                int wsolaExitLagSamples = result.isObject() ? static_cast<int> (result.getProperty ("wsolaExitLagSamples", 0)) : 0;
                                double wsolaCorrelationScore = result.isObject() ? static_cast<double> (result.getProperty ("wsolaCorrelationScore", 0.0)) : 0.0;
                                bool phaseLockUsed = result.isObject() && static_cast<bool> (result.getProperty ("phaseLockUsed", false));
                                bool phaseLockFallbackUsed = result.isObject() && static_cast<bool> (result.getProperty ("phaseLockFallbackUsed", false));
                                bool phaseAlignedEntry = result.isObject() && static_cast<bool> (result.getProperty ("phaseAlignedEntry", false));
                                bool phaseAlignedExit = result.isObject() && static_cast<bool> (result.getProperty ("phaseAlignedExit", false));
                                int phasePeakCount = result.isObject() ? static_cast<int> (result.getProperty ("phasePeakCount", 0)) : 0;
                                bool transitionHqUsed = result.isObject() && static_cast<bool> (result.getProperty ("transitionHqUsed", false));
                                bool transitionHqFallbackUsed = result.isObject() && static_cast<bool> (result.getProperty ("transitionHqFallbackUsed", false));
                                double transitionStartSec = result.isObject() ? static_cast<double> (result.getProperty ("transitionStartSec", 0.0)) : 0.0;
                                double transitionEndSec = result.isObject() ? static_cast<double> (result.getProperty ("transitionEndSec", 0.0)) : 0.0;
                                double transitionTransientPeak = result.isObject() ? static_cast<double> (result.getProperty ("transitionTransientPeak", 0.0)) : 0.0;
                                double transitionVoicedCorePeak = result.isObject() ? static_cast<double> (result.getProperty ("transitionVoicedCorePeak", 0.0)) : 0.0;
                                double transitionResidualPeak = result.isObject() ? static_cast<double> (result.getProperty ("transitionResidualPeak", 0.0)) : 0.0;
                                bool transitionEnvelopeCorrectionUsed = result.isObject() && static_cast<bool> (result.getProperty ("transitionEnvelopeCorrectionUsed", false));
                                bool engineV2Used = result.isObject() && static_cast<bool> (result.getProperty ("engineV2Used", false));
                                bool engineV2FallbackUsed = result.isObject() && static_cast<bool> (result.getProperty ("engineV2FallbackUsed", false));
                                int engineV2TransitionCount = result.isObject() ? static_cast<int> (result.getProperty ("engineV2TransitionCount", 0)) : 0;
                                double engineV2TransitionStartSec = result.isObject() ? static_cast<double> (result.getProperty ("engineV2TransitionStartSec", 0.0)) : 0.0;
                                double engineV2TransitionEndSec = result.isObject() ? static_cast<double> (result.getProperty ("engineV2TransitionEndSec", 0.0)) : 0.0;
                                double engineV2HarmonicSupportPeak = result.isObject() ? static_cast<double> (result.getProperty ("engineV2HarmonicSupportPeak", 0.0)) : 0.0;
                                double engineV2ResidualSupportPeak = result.isObject() ? static_cast<double> (result.getProperty ("engineV2ResidualSupportPeak", 0.0)) : 0.0;
                                double engineV2EnvelopeSupportPeak = result.isObject() ? static_cast<double> (result.getProperty ("engineV2EnvelopeSupportPeak", 0.0)) : 0.0;
                                bool transientBypassUsed = result.isObject() && static_cast<bool> (result.getProperty ("transientBypassUsed", false));
                                bool residualCarryUsed = result.isObject() && static_cast<bool> (result.getProperty ("residualCarryUsed", false));
                                double cepstralCutoffUsed = result.isObject() ? static_cast<double> (result.getProperty ("cepstralCutoffUsed", 0.0)) : 0.0;
                                int engineV2FftSize = result.isObject() ? static_cast<int> (result.getProperty ("fftSizeUsed", 0)) : 0;
                                int engineV2HopSize = result.isObject() ? static_cast<int> (result.getProperty ("hopSizeUsed", 0)) : 0;
                                bool immediateLeftNeighborUsed = result.isObject() && static_cast<bool> (result.getProperty ("immediateLeftNeighborUsed", false));
                                bool immediateRightNeighborUsed = result.isObject() && static_cast<bool> (result.getProperty ("immediateRightNeighborUsed", false));
                                int leftNeighborSamplesRendered = result.isObject() ? static_cast<int> (result.getProperty ("leftNeighborSamplesRendered", 0)) : 0;
                                int rightNeighborSamplesRendered = result.isObject() ? static_cast<int> (result.getProperty ("rightNeighborSamplesRendered", 0)) : 0;
                                double leftNeighborSmoothMs = result.isObject() ? static_cast<double> (result.getProperty ("leftNeighborSmoothMs", 0.0)) : 0.0;
                                double rightNeighborSmoothMs = result.isObject() ? static_cast<double> (result.getProperty ("rightNeighborSmoothMs", 0.0)) : 0.0;
                                bool nonImmediateNeighborTouched = result.isObject() && static_cast<bool> (result.getProperty ("nonImmediateNeighborTouched", false));
                                double entryAlignmentOffsetMs = result.isObject() ? static_cast<double> (result.getProperty ("entryAlignmentOffsetMs", 0.0)) : 0.0;
                                double exitAlignmentOffsetMs = result.isObject() ? static_cast<double> (result.getProperty ("exitAlignmentOffsetMs", 0.0)) : 0.0;
                                bool firstVoicedCyclesEntryUsed = result.isObject() && static_cast<bool> (result.getProperty ("firstVoicedCyclesEntryUsed", false));
                                bool firstVoicedCyclesExitUsed = result.isObject() && static_cast<bool> (result.getProperty ("firstVoicedCyclesExitUsed", false));
                                bool v3TransitionPairUsed = result.isObject() && static_cast<bool> (result.getProperty ("v3TransitionPairUsed", false));
                                bool v3ContinuousRenderUsed = result.isObject() && static_cast<bool> (result.getProperty ("v3ContinuousRenderUsed", false));
                                double v3EntryAnchorMs = result.isObject() ? static_cast<double> (result.getProperty ("v3EntryAnchorMs", 0.0)) : 0.0;
                                double v3ExitAnchorMs = result.isObject() ? static_cast<double> (result.getProperty ("v3ExitAnchorMs", 0.0)) : 0.0;
                                int v3FirstCyclesEntryCount = result.isObject() ? static_cast<int> (result.getProperty ("v3FirstCyclesEntryCount", 0)) : 0;
                                int v3FirstCyclesExitCount = result.isObject() ? static_cast<int> (result.getProperty ("v3FirstCyclesExitCount", 0)) : 0;
                                double v3ShellDurationMs = result.isObject() ? static_cast<double> (result.getProperty ("v3ShellDurationMs", 0.0)) : 0.0;
                                double v3BodyDurationMs = result.isObject() ? static_cast<double> (result.getProperty ("v3BodyDurationMs", 0.0)) : 0.0;
                                double v3ResidualMix = result.isObject() ? static_cast<double> (result.getProperty ("v3ResidualMix", 0.0)) : 0.0;
                                juce::String v3FormantMode = result.isObject() ? result.getProperty ("v3FormantMode", {}).toString() : juce::String();
                                double v3NeighborLeftOverlapMs = result.isObject() ? static_cast<double> (result.getProperty ("v3NeighborLeftOverlapMs", 0.0)) : 0.0;
                                double v3NeighborRightOverlapMs = result.isObject() ? static_cast<double> (result.getProperty ("v3NeighborRightOverlapMs", 0.0)) : 0.0;
                                if (! pitchRegressionJob.isVoid())
                                {
                                    auto nativeResult = juce::var (new juce::DynamicObject());
                                    if (auto* nativeResultObject = nativeResult.getDynamicObject())
                                    {
                                        nativeResultObject->setProperty ("clipId", clipId);
                                        nativeResultObject->setProperty ("requestId", requestId);
                                        nativeResultObject->setProperty ("renderMode", renderMode);
                                        nativeResultObject->setProperty ("requestedRendererBranch", requestedRendererBranch);
                                        nativeResultObject->setProperty ("actualRendererBranch", actualRendererBranch);
                                        nativeResultObject->setProperty ("pitchOnlyRecoveryPath", pitchOnlyRecoveryPath);
                                        nativeResultObject->setProperty ("pitchOnlyNeutralFormantUsed", pitchOnlyNeutralFormantUsed);
                                        nativeResultObject->setProperty ("processingMode", processingMode);
                                        nativeResultObject->setProperty ("formantCurveUsed", formantCurveUsed);
                                        nativeResultObject->setProperty ("explicitFormantRequested", explicitFormantRequested);
                                        nativeResultObject->setProperty ("pitchOnlyFormantSuppressed", pitchOnlyFormantSuppressed);
                                        nativeResultObject->setProperty ("usedFallback", usedFallback);
                                        nativeResultObject->setProperty ("fallbackReason", fallbackReason);
                                        nativeResultObject->setProperty ("hardFailReason", hardFailReason);
                                        nativeResultObject->setProperty ("pitchRenderStrategy", pitchRenderStrategy);
                                        nativeResultObject->setProperty ("phraseHqRenderUsed", phraseHqRenderUsed);
                                        nativeResultObject->setProperty ("phraseHqExpandedToFullClip", phraseHqExpandedToFullClip);
                                        nativeResultObject->setProperty ("phraseHqStartSec", phraseHqStartSec);
                                        nativeResultObject->setProperty ("phraseHqEndSec", phraseHqEndSec);
                                        nativeResultObject->setProperty ("pitchRenderProductPath", pitchRenderProductPath);
                                        nativeResultObject->setProperty ("pitchRenderBackendId", pitchRenderBackendId);
                                        nativeResultObject->setProperty ("pitchRenderBackendVersion", pitchRenderBackendVersion);
                                        nativeResultObject->setProperty ("pitchRenderBackendFailureCode", pitchRenderBackendFailureCode);
                                        nativeResultObject->setProperty ("pitchRenderBackendCapabilities", pitchRenderBackendCapabilities);
                                        nativeResultObject->setProperty ("pitchRenderBackendDiagnostics", pitchRenderBackendDiagnostics);
                                        nativeResultObject->setProperty ("pitchRenderCommitPolicy", pitchRenderCommitPolicy);
                                        nativeResultObject->setProperty ("pitchRenderDryProtectedSamples", pitchRenderDryProtectedSamples);
                                        nativeResultObject->setProperty ("pitchRenderContextDurationSec", pitchRenderContextDurationSec);
                                        nativeResultObject->setProperty ("pitchRenderCommitDurationSec", pitchRenderCommitDurationSec);
                                        nativeResultObject->setProperty ("pitchRenderJobStartDelayMs", pitchRenderJobStartDelayMs);
                                        nativeResultObject->setProperty ("pitchRenderDirection", pitchRenderDirection);
                                        nativeResultObject->setProperty ("downshiftFormantGuardUsed", downshiftFormantGuardUsed);
                                        nativeResultObject->setProperty ("downshiftFormantGuardAlpha", downshiftFormantGuardAlpha);
                                        nativeResultObject->setProperty ("noteHqEffectiveStartSec", noteHqEffectiveStartSec);
                                        nativeResultObject->setProperty ("noteHqEffectiveEndSec", noteHqEffectiveEndSec);
                                        nativeResultObject->setProperty ("noteHqContextStartSec", noteHqContextStartSec);
                                        nativeResultObject->setProperty ("noteHqContextEndSec", noteHqContextEndSec);
                                        nativeResultObject->setProperty ("noteHqAudibleCommitStartSec", noteHqAudibleCommitStartSec);
                                        nativeResultObject->setProperty ("noteHqAudibleCommitEndSec", noteHqAudibleCommitEndSec);
                                        nativeResultObject->setProperty ("noteHqPreBodyDryProtectedSamples", noteHqPreBodyDryProtectedSamples);
                                        nativeResultObject->setProperty ("noteHqEntryInsideBodyFadeMs", noteHqEntryInsideBodyFadeMs);
                                        nativeResultObject->setProperty ("noteHqExitLeadInMs", noteHqExitLeadInMs);
                                        nativeResultObject->setProperty ("noteHqEntryBridgeStartSec", noteHqEntryBridgeStartSec);
                                        nativeResultObject->setProperty ("noteHqEntryBridgeEndSec", noteHqEntryBridgeEndSec);
                                        nativeResultObject->setProperty ("noteHqEntryBridgeWetLagMs", noteHqEntryBridgeWetLagMs);
                                        nativeResultObject->setProperty ("noteHqEntryBridgeEnvelopeGainDb", noteHqEntryBridgeEnvelopeGainDb);
                                        nativeResultObject->setProperty ("noteHqEntryBridgeUsed", noteHqEntryBridgeUsed);
                                        nativeResultObject->setProperty ("noteHqEntryTransientDryPreservedMs", noteHqEntryTransientDryPreservedMs);
                                        nativeResultObject->setProperty ("pitchOnlyEntrySimpleHandoffUsed", pitchOnlyEntrySimpleHandoffUsed);
                                        nativeResultObject->setProperty ("pitchOnlyEntrySafeHandoffUsed", pitchOnlyEntrySafeHandoffUsed);
                                        nativeResultObject->setProperty ("pitchOnlyEntryDryHoldMs", pitchOnlyEntryDryHoldMs);
                                        nativeResultObject->setProperty ("pitchOnlyEntrySafeBridgeMs", pitchOnlyEntrySafeBridgeMs);
                                        nativeResultObject->setProperty ("pitchOnlyEntryWetAlignmentMs", pitchOnlyEntryWetAlignmentMs);
                                        nativeResultObject->setProperty ("pitchOnlyEntryWetGainDb", pitchOnlyEntryWetGainDb);
                                        nativeResultObject->setProperty ("pitchOnlyEntryWetVsDryRmsDb", pitchOnlyEntryWetVsDryRmsDb);
                                        nativeResultObject->setProperty ("pitchOnlyEntryEqualPowerBlendUsed", pitchOnlyEntryEqualPowerBlendUsed);
                                        nativeResultObject->setProperty ("pitchOnlyEntryRmsContinuityUsed", pitchOnlyEntryRmsContinuityUsed);
                                        nativeResultObject->setProperty ("pitchOnlyEntryRmsContinuityGainDb", pitchOnlyEntryRmsContinuityGainDb);
                                        nativeResultObject->setProperty ("pitchOnlyEntryRmsContinuityMs", pitchOnlyEntryRmsContinuityMs);
                                        nativeResultObject->setProperty ("pitchOnlyEntryPhaseSafeUsed", pitchOnlyEntryPhaseSafeUsed);
                                        nativeResultObject->setProperty ("pitchOnlyEntryWetAlignmentAccepted", pitchOnlyEntryWetAlignmentAccepted);
                                        nativeResultObject->setProperty ("pitchOnlyEntryFirstCycleCorrelation", pitchOnlyEntryFirstCycleCorrelation);
                                        nativeResultObject->setProperty ("pitchOnlyEntryZeroCrossOffsetMs", pitchOnlyEntryZeroCrossOffsetMs);
                                        nativeResultObject->setProperty ("pitchOnlyEntryBridgeGainRampDb", pitchOnlyEntryBridgeGainRampDb);
                                        nativeResultObject->setProperty ("pitchOnlyDownshiftCoreEnvelopePassUsed", pitchOnlyDownshiftCoreEnvelopePassUsed);
                                        nativeResultObject->setProperty ("pitchOnlyDownshiftCoreRmsTrimDb", pitchOnlyDownshiftCoreRmsTrimDb);
                                        nativeResultObject->setProperty ("pitchOnlyDownshiftCoreEnvelopeMaxDb", pitchOnlyDownshiftCoreEnvelopeMaxDb);
                                        nativeResultObject->setProperty ("pitchOnlyDownshiftCoreEnvelopeFrames", pitchOnlyDownshiftCoreEnvelopeFrames);
                                        nativeResultObject->setProperty ("pitchOnlyEntryWetLagMs", pitchOnlyEntryWetLagMs);
                                        nativeResultObject->setProperty ("pitchOnlyEntryBridgeDurationMs", pitchOnlyEntryBridgeDurationMs);
                                        nativeResultObject->setProperty ("pitchOnlyExitDryRestoreUsed", pitchOnlyExitDryRestoreUsed);
                                        nativeResultObject->setProperty ("pitchOnlyExitDryRestoreStartSec", pitchOnlyExitDryRestoreStartSec);
                                        nativeResultObject->setProperty ("pitchOnlyExitDryRestoreEndSec", pitchOnlyExitDryRestoreEndSec);
                                        nativeResultObject->setProperty ("noteHqEditIslandCount", noteHqEditIslandCount);
                                        nativeResultObject->setProperty ("noteHqEditedNoteCount", noteHqEditedNoteCount);
                                        nativeResultObject->setProperty ("noteHqEntryPitchHandoffUsed", noteHqEntryPitchHandoffUsed);
                                        nativeResultObject->setProperty ("noteHqEntryPitchHandoffStartSec", noteHqEntryPitchHandoffStartSec);
                                        nativeResultObject->setProperty ("noteHqEntryPitchHandoffEndSec", noteHqEntryPitchHandoffEndSec);
                                        nativeResultObject->setProperty ("noteHqEntryPitchHandoffPreMs", noteHqEntryPitchHandoffPreMs);
                                        nativeResultObject->setProperty ("noteHqEntryPitchHandoffBodyMs", noteHqEntryPitchHandoffBodyMs);
                                        nativeResultObject->setProperty ("noteHqEntryPitchSlopeJumpStPerSec", noteHqEntryPitchSlopeJumpStPerSec);
                                        nativeResultObject->setProperty ("noteHqEntryPitchAccelerationLimited", noteHqEntryPitchAccelerationLimited);
                                        nativeResultObject->setProperty ("outputDurationSec", outputDurationSec);
                                        nativeResultObject->setProperty ("postApplyRouteStatus", postApplyRouteStatus);
                                        if (! appFinalCapture.isVoid())
                                            nativeResultObject->setProperty ("appFinalCapture", appFinalCapture);
                                        if (! appFinalBakedCapture.isVoid())
                                            nativeResultObject->setProperty ("appFinalBakedCapture", appFinalBakedCapture);
                                        if (! appFinalParityReport.isVoid())
                                            nativeResultObject->setProperty ("appFinalParityReport", appFinalParityReport);
                                        if (appFinalRouteReportPath.isNotEmpty())
                                            nativeResultObject->setProperty ("appFinalRouteReportPath", appFinalRouteReportPath);
                                        if (appFinalBakedContextPath.isNotEmpty())
                                            nativeResultObject->setProperty ("appFinalBakedContextPath", appFinalBakedContextPath);
                                        if (appFinalPlaybackContextPath.isNotEmpty())
                                            nativeResultObject->setProperty ("appFinalPlaybackContextPath", appFinalPlaybackContextPath);
                                        if (appFinalParityReportPath.isNotEmpty())
                                            nativeResultObject->setProperty ("appFinalParityReportPath", appFinalParityReportPath);
                                        nativeResultObject->setProperty ("bridgeUsed", bridgeUsed);
                                        nativeResultObject->setProperty ("bridgeFallbackUsed", bridgeFallbackUsed);
                                        nativeResultObject->setProperty ("bridgeStartSec", bridgeStartSec);
                                        nativeResultObject->setProperty ("bridgeLengthMs", bridgeLengthMs);
                                        nativeResultObject->setProperty ("bridgeAlignmentLagSamples", bridgeAlignmentLagSamples);
                                        nativeResultObject->setProperty ("bridgeCorrelationScore", bridgeCorrelationScore);
                                        nativeResultObject->setProperty ("bridgeGainDeltaDb", bridgeGainDeltaDb);
                                        nativeResultObject->setProperty ("bodyReplacementUsed", bodyReplacementUsed);
                                        nativeResultObject->setProperty ("bodyReplacementFallbackUsed", bodyReplacementFallbackUsed);
                                        nativeResultObject->setProperty ("entryLockStartSec", entryLockStartSec);
                                        nativeResultObject->setProperty ("entryLockLengthMs", entryLockLengthMs);
                                        nativeResultObject->setProperty ("exitLockStartSec", exitLockStartSec);
                                        nativeResultObject->setProperty ("renderedBodyStartSec", renderedBodyStartSec);
                                        nativeResultObject->setProperty ("renderedBodyEndSec", renderedBodyEndSec);
                                        nativeResultObject->setProperty ("islandNativeUsed", islandNativeUsed);
                                        nativeResultObject->setProperty ("islandNativeFallbackUsed", islandNativeFallbackUsed);
                                        nativeResultObject->setProperty ("islandRenderStartSec", islandRenderStartSec);
                                        nativeResultObject->setProperty ("islandRenderEndSec", islandRenderEndSec);
                                        nativeResultObject->setProperty ("transientMaskPeak", transientMaskPeak);
                                        nativeResultObject->setProperty ("voicedCoreMaskPeak", voicedCoreMaskPeak);
                                        nativeResultObject->setProperty ("hpssUsed", hpssUsed);
                                        nativeResultObject->setProperty ("hpssFallbackUsed", hpssFallbackUsed);
                                        nativeResultObject->setProperty ("harmonicMaskPeak", harmonicMaskPeak);
                                        nativeResultObject->setProperty ("aperiodicMaskPeak", aperiodicMaskPeak);
                                        nativeResultObject->setProperty ("spectralEnvelopeCorrectionUsed", spectralEnvelopeCorrectionUsed);
                                        nativeResultObject->setProperty ("pitchOnlyCoreTimbreCorrectionUsed", pitchOnlyCoreTimbreCorrectionUsed);
                                        nativeResultObject->setProperty ("pitchOnlyCoreEnvelopeMix", pitchOnlyCoreEnvelopeMix);
                                        nativeResultObject->setProperty ("pitchOnlyCoreRmsTrimDb", pitchOnlyCoreRmsTrimDb);
                                        nativeResultObject->setProperty ("pitchOnlyCoreEnvelopeLifter", pitchOnlyCoreEnvelopeLifter);
                                        nativeResultObject->setProperty ("pitchOnlyEntryTimbreCorrectionUsed", pitchOnlyEntryTimbreCorrectionUsed);
                                        nativeResultObject->setProperty ("pitchOnlyEntryRmsTrimDb", pitchOnlyEntryRmsTrimDb);
                                        nativeResultObject->setProperty ("pitchOnlyEntryTiltDb", pitchOnlyEntryTiltDb);
                                        nativeResultObject->setProperty ("pitchOnlyEntryHandoffUsed", pitchOnlyEntryHandoffUsed);
                                        nativeResultObject->setProperty ("pitchOnlyExitHandoffUsed", pitchOnlyExitHandoffUsed);
                                        nativeResultObject->setProperty ("vocalSourceFilterUsed", vocalSourceFilterUsed);
                                        nativeResultObject->setProperty ("vocalSourceFilterVoicedCoverage", vocalSourceFilterVoicedCoverage);
                                        nativeResultObject->setProperty ("vocalSourceFilterResidualMix", vocalSourceFilterResidualMix);
                                        nativeResultObject->setProperty ("vocalSourceFilterFallbackUsed", vocalSourceFilterFallbackUsed);
                                        nativeResultObject->setProperty ("vocalSourceFilterFallbackReason", vocalSourceFilterFallbackReason);
                                        nativeResultObject->setProperty ("vocalSourceFilterEntryDryMs", vocalSourceFilterEntryDryMs);
                                        nativeResultObject->setProperty ("vocalSourceFilterExitDryMs", vocalSourceFilterExitDryMs);
                                        nativeResultObject->setProperty ("wsolaUsed", wsolaUsed);
                                        nativeResultObject->setProperty ("wsolaFallbackUsed", wsolaFallbackUsed);
                                        nativeResultObject->setProperty ("wsolaEntryLagSamples", wsolaEntryLagSamples);
                                        nativeResultObject->setProperty ("wsolaExitLagSamples", wsolaExitLagSamples);
                                        nativeResultObject->setProperty ("wsolaCorrelationScore", wsolaCorrelationScore);
                                        nativeResultObject->setProperty ("phaseLockUsed", phaseLockUsed);
                                        nativeResultObject->setProperty ("phaseLockFallbackUsed", phaseLockFallbackUsed);
                                        nativeResultObject->setProperty ("phaseAlignedEntry", phaseAlignedEntry);
                                        nativeResultObject->setProperty ("phaseAlignedExit", phaseAlignedExit);
                                        nativeResultObject->setProperty ("phasePeakCount", phasePeakCount);
                                        nativeResultObject->setProperty ("transitionHqUsed", transitionHqUsed);
                                        nativeResultObject->setProperty ("transitionHqFallbackUsed", transitionHqFallbackUsed);
                                        nativeResultObject->setProperty ("transitionStartSec", transitionStartSec);
                                        nativeResultObject->setProperty ("transitionEndSec", transitionEndSec);
                                        nativeResultObject->setProperty ("transitionTransientPeak", transitionTransientPeak);
                                        nativeResultObject->setProperty ("transitionVoicedCorePeak", transitionVoicedCorePeak);
                                        nativeResultObject->setProperty ("transitionResidualPeak", transitionResidualPeak);
                                        nativeResultObject->setProperty ("transitionEnvelopeCorrectionUsed", transitionEnvelopeCorrectionUsed);
                                        nativeResultObject->setProperty ("engineV2Used", engineV2Used);
                                        nativeResultObject->setProperty ("engineV2FallbackUsed", engineV2FallbackUsed);
                                        nativeResultObject->setProperty ("engineV2TransitionCount", engineV2TransitionCount);
                                        nativeResultObject->setProperty ("engineV2TransitionStartSec", engineV2TransitionStartSec);
                                        nativeResultObject->setProperty ("engineV2TransitionEndSec", engineV2TransitionEndSec);
                                        nativeResultObject->setProperty ("engineV2HarmonicSupportPeak", engineV2HarmonicSupportPeak);
                                        nativeResultObject->setProperty ("engineV2ResidualSupportPeak", engineV2ResidualSupportPeak);
                                        nativeResultObject->setProperty ("engineV2EnvelopeSupportPeak", engineV2EnvelopeSupportPeak);
                                        nativeResultObject->setProperty ("transientBypassUsed", transientBypassUsed);
                                        nativeResultObject->setProperty ("residualCarryUsed", residualCarryUsed);
                                        nativeResultObject->setProperty ("cepstralCutoffUsed", cepstralCutoffUsed);
                                        nativeResultObject->setProperty ("fftSizeUsed", engineV2FftSize);
                                        nativeResultObject->setProperty ("hopSizeUsed", engineV2HopSize);
                                        nativeResultObject->setProperty ("immediateLeftNeighborUsed", immediateLeftNeighborUsed);
                                        nativeResultObject->setProperty ("immediateRightNeighborUsed", immediateRightNeighborUsed);
                                        nativeResultObject->setProperty ("leftNeighborSamplesRendered", leftNeighborSamplesRendered);
                                        nativeResultObject->setProperty ("rightNeighborSamplesRendered", rightNeighborSamplesRendered);
                                        nativeResultObject->setProperty ("leftNeighborSmoothMs", leftNeighborSmoothMs);
                                        nativeResultObject->setProperty ("rightNeighborSmoothMs", rightNeighborSmoothMs);
                                        nativeResultObject->setProperty ("nonImmediateNeighborTouched", nonImmediateNeighborTouched);
                                        nativeResultObject->setProperty ("entryAlignmentOffsetMs", entryAlignmentOffsetMs);
                                        nativeResultObject->setProperty ("exitAlignmentOffsetMs", exitAlignmentOffsetMs);
                                        nativeResultObject->setProperty ("firstVoicedCyclesEntryUsed", firstVoicedCyclesEntryUsed);
                                        nativeResultObject->setProperty ("firstVoicedCyclesExitUsed", firstVoicedCyclesExitUsed);
                                        nativeResultObject->setProperty ("v3TransitionPairUsed", v3TransitionPairUsed);
                                        nativeResultObject->setProperty ("v3ContinuousRenderUsed", v3ContinuousRenderUsed);
                                        nativeResultObject->setProperty ("v3EntryAnchorMs", v3EntryAnchorMs);
                                        nativeResultObject->setProperty ("v3ExitAnchorMs", v3ExitAnchorMs);
                                        nativeResultObject->setProperty ("v3FirstCyclesEntryCount", v3FirstCyclesEntryCount);
                                        nativeResultObject->setProperty ("v3FirstCyclesExitCount", v3FirstCyclesExitCount);
                                        nativeResultObject->setProperty ("v3ShellDurationMs", v3ShellDurationMs);
                                        nativeResultObject->setProperty ("v3BodyDurationMs", v3BodyDurationMs);
                                        nativeResultObject->setProperty ("v3ResidualMix", v3ResidualMix);
                                        nativeResultObject->setProperty ("v3FormantMode", v3FormantMode);
                                        nativeResultObject->setProperty ("v3NeighborLeftOverlapMs", v3NeighborLeftOverlapMs);
                                        nativeResultObject->setProperty ("v3NeighborRightOverlapMs", v3NeighborRightOverlapMs);
                                        nativeResultObject->setProperty ("previewCoverageStartSec", previewCoverageStartSec);
                                        nativeResultObject->setProperty ("previewCoverageEndSec", previewCoverageEndSec);
                                        nativeResultObject->setProperty ("candidateCoverageStartSec", candidateCoverageStartSec);
                                        nativeResultObject->setProperty ("candidateCoverageEndSec", candidateCoverageEndSec);
                                        const juce::ScopedLock resultLock (pitchRegressionNativeResultLock);
                                        lastPitchRegressionNativeResult = nativeResult;
                                    }
                                }

                                logPitchEditorFormant ("job finished clip=" + clipId
                                    + " requestId=" + requestId
                                    + " requestGroupId=" + requestGroupId
                                    + " renderMode=" + renderMode
                                    + " success=" + juce::String(success ? "true" : "false")
                                    + " cancelled=" + juce::String(cancelled ? "true" : "false")
                                    + " swapDeferred=" + juce::String(swapDeferred ? "true" : "false")
                                    + " requestedBranch=" + requestedRendererBranch
                                    + " actualBranch=" + actualRendererBranch
                                    + " usedFallback=" + juce::String (usedFallback ? "true" : "false")
                                    + " fallbackReason=" + fallbackReason
                                    + " previewCoverageStart=" + juce::String(previewCoverageStartSec, 3)
                                    + " previewCoverageEnd=" + juce::String(previewCoverageEndSec, 3)
                                    + " restored=" + juce::String(restored ? "true" : "false")
                                    + " outputFile=" + outputFile);
                                juce::MessageManager::callAsync ([safeThis, clipId, success, outputFile, requestId, restored, renderMode, cancelled, swapDeferred, previewCoverageStartSec, previewCoverageEndSec, candidateCoverageStartSec, candidateCoverageEndSec, requestedRendererBranch, actualRendererBranch, pitchOnlyRecoveryPath, pitchOnlyNeutralFormantUsed, processingMode, formantCurveUsed, explicitFormantRequested, pitchOnlyFormantSuppressed, usedFallback, fallbackReason, hardFailReason, pitchRenderStrategy, phraseHqRenderUsed, phraseHqExpandedToFullClip, phraseHqStartSec, phraseHqEndSec, pitchRenderProductPath, pitchRenderBackendId, pitchRenderBackendVersion, pitchRenderBackendFailureCode, pitchRenderBackendCapabilities, pitchRenderBackendDiagnostics, pitchRenderCommitPolicy, pitchRenderDryProtectedSamples, pitchRenderContextDurationSec, pitchRenderCommitDurationSec, pitchRenderJobStartDelayMs, pitchRenderDirection, downshiftFormantGuardUsed, downshiftFormantGuardAlpha, noteHqEffectiveStartSec, noteHqEffectiveEndSec, noteHqContextStartSec, noteHqContextEndSec, noteHqAudibleCommitStartSec, noteHqAudibleCommitEndSec, noteHqPreBodyDryProtectedSamples, noteHqEntryInsideBodyFadeMs, noteHqExitLeadInMs, noteHqEntryBridgeStartSec, noteHqEntryBridgeEndSec, noteHqEntryBridgeWetLagMs, noteHqEntryBridgeEnvelopeGainDb, noteHqEntryBridgeUsed, noteHqEntryTransientDryPreservedMs, pitchOnlyEntrySimpleHandoffUsed, pitchOnlyEntrySafeHandoffUsed, pitchOnlyEntryDryHoldMs, pitchOnlyEntrySafeBridgeMs, pitchOnlyEntryWetAlignmentMs, pitchOnlyEntryWetGainDb, pitchOnlyEntryWetVsDryRmsDb, pitchOnlyEntryEqualPowerBlendUsed, pitchOnlyEntryRmsContinuityUsed, pitchOnlyEntryRmsContinuityGainDb, pitchOnlyEntryRmsContinuityMs, pitchOnlyEntryPhaseSafeUsed, pitchOnlyEntryWetAlignmentAccepted, pitchOnlyEntryFirstCycleCorrelation, pitchOnlyEntryZeroCrossOffsetMs, pitchOnlyEntryBridgeGainRampDb, pitchOnlyDownshiftCoreEnvelopePassUsed, pitchOnlyDownshiftCoreRmsTrimDb, pitchOnlyDownshiftCoreEnvelopeMaxDb, pitchOnlyDownshiftCoreEnvelopeFrames, pitchOnlyEntryWetLagMs, pitchOnlyEntryBridgeDurationMs, pitchOnlyExitDryRestoreUsed, pitchOnlyExitDryRestoreStartSec, pitchOnlyExitDryRestoreEndSec, noteHqEditIslandCount, noteHqEditedNoteCount, noteHqEntryPitchHandoffUsed, noteHqEntryPitchHandoffStartSec, noteHqEntryPitchHandoffEndSec, noteHqEntryPitchHandoffPreMs, noteHqEntryPitchHandoffBodyMs, noteHqEntryPitchSlopeJumpStPerSec, noteHqEntryPitchAccelerationLimited, outputDurationSec, postApplyRouteStatus, appFinalCapture, appFinalBakedCapture, appFinalParityReport, appFinalRouteReportPath, appFinalBakedContextPath, appFinalPlaybackContextPath, appFinalParityReportPath, bridgeUsed, bridgeFallbackUsed, bridgeStartSec, bridgeLengthMs, bridgeAlignmentLagSamples, bridgeCorrelationScore, bridgeGainDeltaDb, bodyReplacementUsed, bodyReplacementFallbackUsed, entryLockStartSec, entryLockLengthMs, exitLockStartSec, renderedBodyStartSec, renderedBodyEndSec, islandNativeUsed, islandNativeFallbackUsed, islandRenderStartSec, islandRenderEndSec, transientMaskPeak, voicedCoreMaskPeak, hpssUsed, hpssFallbackUsed, harmonicMaskPeak, aperiodicMaskPeak, spectralEnvelopeCorrectionUsed, pitchOnlyCoreTimbreCorrectionUsed, pitchOnlyCoreEnvelopeMix, pitchOnlyCoreRmsTrimDb, pitchOnlyCoreEnvelopeLifter, pitchOnlyEntryTimbreCorrectionUsed, pitchOnlyEntryRmsTrimDb, pitchOnlyEntryTiltDb, pitchOnlyEntryHandoffUsed, pitchOnlyExitHandoffUsed, vocalSourceFilterUsed, vocalSourceFilterVoicedCoverage, vocalSourceFilterResidualMix, vocalSourceFilterFallbackUsed, vocalSourceFilterFallbackReason, vocalSourceFilterEntryDryMs, vocalSourceFilterExitDryMs, wsolaUsed, wsolaFallbackUsed, wsolaEntryLagSamples, wsolaExitLagSamples, wsolaCorrelationScore, phaseLockUsed, phaseLockFallbackUsed, phaseAlignedEntry, phaseAlignedExit, phasePeakCount, transitionHqUsed, transitionHqFallbackUsed, transitionStartSec, transitionEndSec, transitionTransientPeak, transitionVoicedCorePeak, transitionResidualPeak, transitionEnvelopeCorrectionUsed, engineV2Used, engineV2FallbackUsed, engineV2TransitionCount, engineV2TransitionStartSec, engineV2TransitionEndSec, engineV2HarmonicSupportPeak, engineV2ResidualSupportPeak, engineV2EnvelopeSupportPeak, transientBypassUsed, residualCarryUsed, cepstralCutoffUsed, engineV2FftSize, engineV2HopSize, immediateLeftNeighborUsed, immediateRightNeighborUsed, leftNeighborSamplesRendered, rightNeighborSamplesRendered, leftNeighborSmoothMs, rightNeighborSmoothMs, nonImmediateNeighborTouched, entryAlignmentOffsetMs, exitAlignmentOffsetMs, firstVoicedCyclesEntryUsed, firstVoicedCyclesExitUsed, v3TransitionPairUsed, v3ContinuousRenderUsed, v3EntryAnchorMs, v3ExitAnchorMs, v3FirstCyclesEntryCount, v3FirstCyclesExitCount, v3ShellDurationMs, v3BodyDurationMs, v3ResidualMix, v3FormantMode, v3NeighborLeftOverlapMs, v3NeighborRightOverlapMs]() {
                                    if (safeThis == nullptr || safeThis->secondaryWindowClosing)
                                        return;

                                    logPitchEditorFormant ("emitting pitchCorrectionComplete clip=" + clipId
                                        + " requestId=" + requestId
                                        + " renderMode=" + renderMode
                                        + " cancelled=" + juce::String (cancelled ? "true" : "false")
                                        + " swapDeferred=" + juce::String (swapDeferred ? "true" : "false")
                                        + " requestedBranch=" + requestedRendererBranch
                                        + " actualBranch=" + actualRendererBranch
                                        + " usedFallback=" + juce::String (usedFallback ? "true" : "false")
                                        + " previewCoverageStart=" + juce::String(previewCoverageStartSec, 3)
                                        + " previewCoverageEnd=" + juce::String(previewCoverageEndSec, 3)
                                        + " success=" + juce::String (success ? "true" : "false")
                                        + " outputFile=" + outputFile);
                                    auto obj = std::make_unique<juce::DynamicObject>();
                                    obj->setProperty ("clipId", clipId);
                                    obj->setProperty ("success", success);
                                    obj->setProperty ("outputFile", outputFile);
                                    obj->setProperty ("requestId", requestId);
                                    obj->setProperty ("restored", restored);
                                    obj->setProperty ("renderMode", renderMode);
                                    obj->setProperty ("cancelled", cancelled);
                                    obj->setProperty ("swapDeferred", swapDeferred);
                                    obj->setProperty ("previewCoverageStartSec", previewCoverageStartSec);
                                    obj->setProperty ("previewCoverageEndSec", previewCoverageEndSec);
                                    obj->setProperty ("candidateCoverageStartSec", candidateCoverageStartSec);
                                    obj->setProperty ("candidateCoverageEndSec", candidateCoverageEndSec);
                                    obj->setProperty ("requestedRendererBranch", requestedRendererBranch);
                                    obj->setProperty ("actualRendererBranch", actualRendererBranch);
                                    obj->setProperty ("pitchOnlyRecoveryPath", pitchOnlyRecoveryPath);
                                    obj->setProperty ("pitchOnlyNeutralFormantUsed", pitchOnlyNeutralFormantUsed);
                                    obj->setProperty ("processingMode", processingMode);
                                    obj->setProperty ("formantCurveUsed", formantCurveUsed);
                                    obj->setProperty ("explicitFormantRequested", explicitFormantRequested);
                                    obj->setProperty ("pitchOnlyFormantSuppressed", pitchOnlyFormantSuppressed);
                                    obj->setProperty ("usedFallback", usedFallback);
                                    obj->setProperty ("fallbackReason", fallbackReason);
                                    obj->setProperty ("hardFailReason", hardFailReason);
                                    obj->setProperty ("pitchRenderStrategy", pitchRenderStrategy);
                                    obj->setProperty ("phraseHqRenderUsed", phraseHqRenderUsed);
                                    obj->setProperty ("phraseHqExpandedToFullClip", phraseHqExpandedToFullClip);
                                    obj->setProperty ("phraseHqStartSec", phraseHqStartSec);
                                    obj->setProperty ("phraseHqEndSec", phraseHqEndSec);
                                    obj->setProperty ("pitchRenderProductPath", pitchRenderProductPath);
                                    obj->setProperty ("pitchRenderBackendId", pitchRenderBackendId);
                                    obj->setProperty ("pitchRenderBackendVersion", pitchRenderBackendVersion);
                                    obj->setProperty ("pitchRenderBackendFailureCode", pitchRenderBackendFailureCode);
                                    obj->setProperty ("pitchRenderBackendCapabilities", pitchRenderBackendCapabilities);
                                    obj->setProperty ("pitchRenderBackendDiagnostics", pitchRenderBackendDiagnostics);
                                    obj->setProperty ("pitchRenderCommitPolicy", pitchRenderCommitPolicy);
                                    obj->setProperty ("pitchRenderDryProtectedSamples", pitchRenderDryProtectedSamples);
                                    obj->setProperty ("pitchRenderContextDurationSec", pitchRenderContextDurationSec);
                                    obj->setProperty ("pitchRenderCommitDurationSec", pitchRenderCommitDurationSec);
                                    obj->setProperty ("pitchRenderJobStartDelayMs", pitchRenderJobStartDelayMs);
                                    obj->setProperty ("pitchRenderDirection", pitchRenderDirection);
                                    obj->setProperty ("downshiftFormantGuardUsed", downshiftFormantGuardUsed);
                                    obj->setProperty ("downshiftFormantGuardAlpha", downshiftFormantGuardAlpha);
                                    obj->setProperty ("noteHqEffectiveStartSec", noteHqEffectiveStartSec);
                                    obj->setProperty ("noteHqEffectiveEndSec", noteHqEffectiveEndSec);
                                    obj->setProperty ("noteHqContextStartSec", noteHqContextStartSec);
                                    obj->setProperty ("noteHqContextEndSec", noteHqContextEndSec);
                                    obj->setProperty ("noteHqAudibleCommitStartSec", noteHqAudibleCommitStartSec);
                                    obj->setProperty ("noteHqAudibleCommitEndSec", noteHqAudibleCommitEndSec);
                                    obj->setProperty ("noteHqPreBodyDryProtectedSamples", noteHqPreBodyDryProtectedSamples);
                                    obj->setProperty ("noteHqEntryInsideBodyFadeMs", noteHqEntryInsideBodyFadeMs);
                                    obj->setProperty ("noteHqExitLeadInMs", noteHqExitLeadInMs);
                                    obj->setProperty ("noteHqEntryBridgeStartSec", noteHqEntryBridgeStartSec);
                                    obj->setProperty ("noteHqEntryBridgeEndSec", noteHqEntryBridgeEndSec);
                                    obj->setProperty ("noteHqEntryBridgeWetLagMs", noteHqEntryBridgeWetLagMs);
                                    obj->setProperty ("noteHqEntryBridgeEnvelopeGainDb", noteHqEntryBridgeEnvelopeGainDb);
                                    obj->setProperty ("noteHqEntryBridgeUsed", noteHqEntryBridgeUsed);
                                    obj->setProperty ("noteHqEntryTransientDryPreservedMs", noteHqEntryTransientDryPreservedMs);
                                    obj->setProperty ("pitchOnlyEntrySimpleHandoffUsed", pitchOnlyEntrySimpleHandoffUsed);
                                    obj->setProperty ("pitchOnlyEntrySafeHandoffUsed", pitchOnlyEntrySafeHandoffUsed);
                                    obj->setProperty ("pitchOnlyEntryDryHoldMs", pitchOnlyEntryDryHoldMs);
                                    obj->setProperty ("pitchOnlyEntrySafeBridgeMs", pitchOnlyEntrySafeBridgeMs);
                                    obj->setProperty ("pitchOnlyEntryWetAlignmentMs", pitchOnlyEntryWetAlignmentMs);
                                    obj->setProperty ("pitchOnlyEntryWetGainDb", pitchOnlyEntryWetGainDb);
                                    obj->setProperty ("pitchOnlyEntryWetVsDryRmsDb", pitchOnlyEntryWetVsDryRmsDb);
                                    obj->setProperty ("pitchOnlyEntryEqualPowerBlendUsed", pitchOnlyEntryEqualPowerBlendUsed);
                                    obj->setProperty ("pitchOnlyEntryRmsContinuityUsed", pitchOnlyEntryRmsContinuityUsed);
                                    obj->setProperty ("pitchOnlyEntryRmsContinuityGainDb", pitchOnlyEntryRmsContinuityGainDb);
                                    obj->setProperty ("pitchOnlyEntryRmsContinuityMs", pitchOnlyEntryRmsContinuityMs);
                                    obj->setProperty ("pitchOnlyEntryPhaseSafeUsed", pitchOnlyEntryPhaseSafeUsed);
                                    obj->setProperty ("pitchOnlyEntryWetAlignmentAccepted", pitchOnlyEntryWetAlignmentAccepted);
                                    obj->setProperty ("pitchOnlyEntryFirstCycleCorrelation", pitchOnlyEntryFirstCycleCorrelation);
                                    obj->setProperty ("pitchOnlyEntryZeroCrossOffsetMs", pitchOnlyEntryZeroCrossOffsetMs);
                                    obj->setProperty ("pitchOnlyEntryBridgeGainRampDb", pitchOnlyEntryBridgeGainRampDb);
                                    obj->setProperty ("pitchOnlyDownshiftCoreEnvelopePassUsed", pitchOnlyDownshiftCoreEnvelopePassUsed);
                                    obj->setProperty ("pitchOnlyDownshiftCoreRmsTrimDb", pitchOnlyDownshiftCoreRmsTrimDb);
                                    obj->setProperty ("pitchOnlyDownshiftCoreEnvelopeMaxDb", pitchOnlyDownshiftCoreEnvelopeMaxDb);
                                    obj->setProperty ("pitchOnlyDownshiftCoreEnvelopeFrames", pitchOnlyDownshiftCoreEnvelopeFrames);
                                    obj->setProperty ("pitchOnlyEntryWetLagMs", pitchOnlyEntryWetLagMs);
                                    obj->setProperty ("pitchOnlyEntryBridgeDurationMs", pitchOnlyEntryBridgeDurationMs);
                                    obj->setProperty ("pitchOnlyExitDryRestoreUsed", pitchOnlyExitDryRestoreUsed);
                                    obj->setProperty ("pitchOnlyExitDryRestoreStartSec", pitchOnlyExitDryRestoreStartSec);
                                    obj->setProperty ("pitchOnlyExitDryRestoreEndSec", pitchOnlyExitDryRestoreEndSec);
                                    obj->setProperty ("noteHqEditIslandCount", noteHqEditIslandCount);
                                    obj->setProperty ("noteHqEditedNoteCount", noteHqEditedNoteCount);
                                    obj->setProperty ("noteHqEntryPitchHandoffUsed", noteHqEntryPitchHandoffUsed);
                                    obj->setProperty ("noteHqEntryPitchHandoffStartSec", noteHqEntryPitchHandoffStartSec);
                                    obj->setProperty ("noteHqEntryPitchHandoffEndSec", noteHqEntryPitchHandoffEndSec);
                                    obj->setProperty ("noteHqEntryPitchHandoffPreMs", noteHqEntryPitchHandoffPreMs);
                                    obj->setProperty ("noteHqEntryPitchHandoffBodyMs", noteHqEntryPitchHandoffBodyMs);
                                    obj->setProperty ("noteHqEntryPitchSlopeJumpStPerSec", noteHqEntryPitchSlopeJumpStPerSec);
                                    obj->setProperty ("noteHqEntryPitchAccelerationLimited", noteHqEntryPitchAccelerationLimited);
                                    obj->setProperty ("outputDurationSec", outputDurationSec);
                                    obj->setProperty ("postApplyRouteStatus", postApplyRouteStatus);
                                    if (! appFinalCapture.isVoid())
                                        obj->setProperty ("appFinalCapture", appFinalCapture);
                                    if (! appFinalBakedCapture.isVoid())
                                        obj->setProperty ("appFinalBakedCapture", appFinalBakedCapture);
                                    if (! appFinalParityReport.isVoid())
                                        obj->setProperty ("appFinalParityReport", appFinalParityReport);
                                    if (appFinalRouteReportPath.isNotEmpty())
                                        obj->setProperty ("appFinalRouteReportPath", appFinalRouteReportPath);
                                    if (appFinalBakedContextPath.isNotEmpty())
                                        obj->setProperty ("appFinalBakedContextPath", appFinalBakedContextPath);
                                    if (appFinalPlaybackContextPath.isNotEmpty())
                                        obj->setProperty ("appFinalPlaybackContextPath", appFinalPlaybackContextPath);
                                    if (appFinalParityReportPath.isNotEmpty())
                                        obj->setProperty ("appFinalParityReportPath", appFinalParityReportPath);
                                    obj->setProperty ("bridgeUsed", bridgeUsed);
                                    obj->setProperty ("bridgeFallbackUsed", bridgeFallbackUsed);
                                    obj->setProperty ("bridgeStartSec", bridgeStartSec);
                                    obj->setProperty ("bridgeLengthMs", bridgeLengthMs);
                                    obj->setProperty ("bridgeAlignmentLagSamples", bridgeAlignmentLagSamples);
                                    obj->setProperty ("bridgeCorrelationScore", bridgeCorrelationScore);
                                    obj->setProperty ("bridgeGainDeltaDb", bridgeGainDeltaDb);
                                    obj->setProperty ("bodyReplacementUsed", bodyReplacementUsed);
                                    obj->setProperty ("bodyReplacementFallbackUsed", bodyReplacementFallbackUsed);
                                    obj->setProperty ("entryLockStartSec", entryLockStartSec);
                                    obj->setProperty ("entryLockLengthMs", entryLockLengthMs);
                                    obj->setProperty ("exitLockStartSec", exitLockStartSec);
                                    obj->setProperty ("renderedBodyStartSec", renderedBodyStartSec);
                                    obj->setProperty ("renderedBodyEndSec", renderedBodyEndSec);
                                    obj->setProperty ("islandNativeUsed", islandNativeUsed);
                                    obj->setProperty ("islandNativeFallbackUsed", islandNativeFallbackUsed);
                                    obj->setProperty ("islandRenderStartSec", islandRenderStartSec);
                                    obj->setProperty ("islandRenderEndSec", islandRenderEndSec);
                                    obj->setProperty ("transientMaskPeak", transientMaskPeak);
                                    obj->setProperty ("voicedCoreMaskPeak", voicedCoreMaskPeak);
                                    obj->setProperty ("hpssUsed", hpssUsed);
                                    obj->setProperty ("hpssFallbackUsed", hpssFallbackUsed);
                                    obj->setProperty ("harmonicMaskPeak", harmonicMaskPeak);
                                    obj->setProperty ("aperiodicMaskPeak", aperiodicMaskPeak);
                                    obj->setProperty ("spectralEnvelopeCorrectionUsed", spectralEnvelopeCorrectionUsed);
                                    obj->setProperty ("pitchOnlyCoreTimbreCorrectionUsed", pitchOnlyCoreTimbreCorrectionUsed);
                                    obj->setProperty ("pitchOnlyCoreEnvelopeMix", pitchOnlyCoreEnvelopeMix);
                                    obj->setProperty ("pitchOnlyCoreRmsTrimDb", pitchOnlyCoreRmsTrimDb);
                                    obj->setProperty ("pitchOnlyCoreEnvelopeLifter", pitchOnlyCoreEnvelopeLifter);
                                    obj->setProperty ("pitchOnlyEntryTimbreCorrectionUsed", pitchOnlyEntryTimbreCorrectionUsed);
                                    obj->setProperty ("pitchOnlyEntryRmsTrimDb", pitchOnlyEntryRmsTrimDb);
                                    obj->setProperty ("pitchOnlyEntryTiltDb", pitchOnlyEntryTiltDb);
                                    obj->setProperty ("pitchOnlyEntryHandoffUsed", pitchOnlyEntryHandoffUsed);
                                    obj->setProperty ("pitchOnlyExitHandoffUsed", pitchOnlyExitHandoffUsed);
                                    obj->setProperty ("vocalSourceFilterUsed", vocalSourceFilterUsed);
                                    obj->setProperty ("vocalSourceFilterVoicedCoverage", vocalSourceFilterVoicedCoverage);
                                    obj->setProperty ("vocalSourceFilterResidualMix", vocalSourceFilterResidualMix);
                                    obj->setProperty ("vocalSourceFilterFallbackUsed", vocalSourceFilterFallbackUsed);
                                    obj->setProperty ("vocalSourceFilterFallbackReason", vocalSourceFilterFallbackReason);
                                    obj->setProperty ("vocalSourceFilterEntryDryMs", vocalSourceFilterEntryDryMs);
                                    obj->setProperty ("vocalSourceFilterExitDryMs", vocalSourceFilterExitDryMs);
                                    obj->setProperty ("wsolaUsed", wsolaUsed);
                                    obj->setProperty ("wsolaFallbackUsed", wsolaFallbackUsed);
                                    obj->setProperty ("wsolaEntryLagSamples", wsolaEntryLagSamples);
                                    obj->setProperty ("wsolaExitLagSamples", wsolaExitLagSamples);
                                    obj->setProperty ("wsolaCorrelationScore", wsolaCorrelationScore);
                                    obj->setProperty ("phaseLockUsed", phaseLockUsed);
                                    obj->setProperty ("phaseLockFallbackUsed", phaseLockFallbackUsed);
                                    obj->setProperty ("phaseAlignedEntry", phaseAlignedEntry);
                                    obj->setProperty ("phaseAlignedExit", phaseAlignedExit);
                                    obj->setProperty ("phasePeakCount", phasePeakCount);
                                    obj->setProperty ("transitionHqUsed", transitionHqUsed);
                                    obj->setProperty ("transitionHqFallbackUsed", transitionHqFallbackUsed);
                                    obj->setProperty ("transitionStartSec", transitionStartSec);
                                    obj->setProperty ("transitionEndSec", transitionEndSec);
                                    obj->setProperty ("transitionTransientPeak", transitionTransientPeak);
                                    obj->setProperty ("transitionVoicedCorePeak", transitionVoicedCorePeak);
                                    obj->setProperty ("transitionResidualPeak", transitionResidualPeak);
                                    obj->setProperty ("transitionEnvelopeCorrectionUsed", transitionEnvelopeCorrectionUsed);
                                    obj->setProperty ("engineV2Used", engineV2Used);
                                    obj->setProperty ("engineV2FallbackUsed", engineV2FallbackUsed);
                                    obj->setProperty ("engineV2TransitionCount", engineV2TransitionCount);
                                    obj->setProperty ("engineV2TransitionStartSec", engineV2TransitionStartSec);
                                    obj->setProperty ("engineV2TransitionEndSec", engineV2TransitionEndSec);
                                    obj->setProperty ("engineV2HarmonicSupportPeak", engineV2HarmonicSupportPeak);
                                    obj->setProperty ("engineV2ResidualSupportPeak", engineV2ResidualSupportPeak);
                                    obj->setProperty ("engineV2EnvelopeSupportPeak", engineV2EnvelopeSupportPeak);
                                    obj->setProperty ("transientBypassUsed", transientBypassUsed);
                                    obj->setProperty ("residualCarryUsed", residualCarryUsed);
                                    obj->setProperty ("cepstralCutoffUsed", cepstralCutoffUsed);
                                    obj->setProperty ("fftSizeUsed", engineV2FftSize);
                                    obj->setProperty ("hopSizeUsed", engineV2HopSize);
                                    obj->setProperty ("immediateLeftNeighborUsed", immediateLeftNeighborUsed);
                                    obj->setProperty ("immediateRightNeighborUsed", immediateRightNeighborUsed);
                                    obj->setProperty ("leftNeighborSamplesRendered", leftNeighborSamplesRendered);
                                    obj->setProperty ("rightNeighborSamplesRendered", rightNeighborSamplesRendered);
                                    obj->setProperty ("leftNeighborSmoothMs", leftNeighborSmoothMs);
                                    obj->setProperty ("rightNeighborSmoothMs", rightNeighborSmoothMs);
                                    obj->setProperty ("nonImmediateNeighborTouched", nonImmediateNeighborTouched);
                                    obj->setProperty ("entryAlignmentOffsetMs", entryAlignmentOffsetMs);
                                    obj->setProperty ("exitAlignmentOffsetMs", exitAlignmentOffsetMs);
                                    obj->setProperty ("firstVoicedCyclesEntryUsed", firstVoicedCyclesEntryUsed);
                                    obj->setProperty ("firstVoicedCyclesExitUsed", firstVoicedCyclesExitUsed);
                                    obj->setProperty ("v3TransitionPairUsed", v3TransitionPairUsed);
                                    obj->setProperty ("v3ContinuousRenderUsed", v3ContinuousRenderUsed);
                                    obj->setProperty ("v3EntryAnchorMs", v3EntryAnchorMs);
                                    obj->setProperty ("v3ExitAnchorMs", v3ExitAnchorMs);
                                    obj->setProperty ("v3FirstCyclesEntryCount", v3FirstCyclesEntryCount);
                                    obj->setProperty ("v3FirstCyclesExitCount", v3FirstCyclesExitCount);
                                    obj->setProperty ("v3ShellDurationMs", v3ShellDurationMs);
                                    obj->setProperty ("v3BodyDurationMs", v3BodyDurationMs);
                                    obj->setProperty ("v3ResidualMix", v3ResidualMix);
                                    obj->setProperty ("v3FormantMode", v3FormantMode);
                                    obj->setProperty ("v3NeighborLeftOverlapMs", v3NeighborLeftOverlapMs);
                                    obj->setProperty ("v3NeighborRightOverlapMs", v3NeighborRightOverlapMs);
                                    safeThis->webView.emitEventIfBrowserIsVisible ("pitchCorrectionComplete",
                                        juce::var (obj.release()));
                                });
                            });
                        }
                        else
                            completion(false);
                    })
                    .withNativeFunction ("previewPitchCorrection", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                            completion(audioEngine.previewPitchCorrection(args[0].toString(), args[1].toString(), args[2]));
                        else
                            completion(false);
                    })
                    .withNativeFunction ("analyzePolyphonic", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                        {
                            auto trackId = args[0].toString();
                            auto clipId  = args[1].toString();
                            auto* engine = &audioEngine;
                            juce::Component::SafePointer<MainComponent> safeThis(this);
                            polyAnalysisBridgePool.addJob([engine, safeThis, trackId, clipId, completion]() mutable {
                                auto result = engine->analyzePolyphonic(trackId, clipId);
                                juce::MessageManager::callAsync([safeThis, completion, result]() mutable {
                                    if (safeThis != nullptr)
                                        completion(result);
                                });
                            });
                        }
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("extractMidiFromAudio", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                        {
                            auto trackId = args[0].toString();
                            auto clipId = args[1].toString();
                            auto* engine = &audioEngine;
                            juce::Component::SafePointer<MainComponent> safeThis(this);
                            polyAnalysisBridgePool.addJob([engine, safeThis, trackId, clipId, completion]() mutable {
                                auto result = engine->extractMidiFromAudio(trackId, clipId);
                                juce::MessageManager::callAsync([safeThis, completion, result]() mutable {
                                    if (safeThis != nullptr)
                                        completion(result);
                                });
                            });
                        }
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("isPolyphonicDetectionAvailable", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(audioEngine.isPolyphonicDetectionAvailable());
                    })
                    .withNativeFunction ("applyPolyPitchCorrection", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                            completion(audioEngine.applyPolyPitchCorrection(args[0].toString(), args[1].toString(), args[2]));
                        else
                            completion(false);
                    })
                    .withNativeFunction ("soloPolyNote", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                            completion(audioEngine.soloPolyNote(args[0].toString(), args[1].toString(), args[2].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("startPitchScrubPreview", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4)
                            completion(audioEngine.startPitchScrubPreview(args[0].toString(), args[1].toString(), args[2], args[3]));
                        else
                            completion(false);
                    })
                    .withNativeFunction ("updatePitchScrubPreview", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.updatePitchScrubPreview(args[0].toString(),
                                static_cast<float> (static_cast<double> (args[1]))));
                        else
                            completion(false);
                    })
                    .withNativeFunction ("stopPitchScrubPreview", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            completion(audioEngine.stopPitchScrubPreview(args[0].toString()));
                        else
                            completion(false);
                    })
                    .withNativeFunction ("getPitchScrubPreviewStatus", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            completion(audioEngine.getPitchScrubPreviewStatus(args[0].toString()));
                        else
                            completion(audioEngine.getPitchScrubPreviewStatus());
                    })
                    .withNativeFunction ("getPitchPreviewRoutingStatus", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            completion(audioEngine.getPitchPreviewRoutingStatus(args[0].toString()));
                        else
                            completion(audioEngine.getPitchPreviewRoutingStatus());
                    })
                    .withNativeFunction ("setClipPitchPreview", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                        {
                            juce::String clipId = args[0].toString();
                            PlaybackEngine::ClipPitchPreviewData previewData;
                            auto* previewObj = args[1].getDynamicObject();
                            auto* segArray = previewObj != nullptr
                                ? previewObj->getProperty ("pitchSegments").getArray()
                                : args[1].getArray();

                            if (segArray != nullptr)
                            {
                                for (const auto& seg : *segArray)
                                {
                                    PlaybackEngine::PitchCorrectionSegment s;
                                    s.startTime  = static_cast<double> (seg.getProperty ("startTime", 0.0));
                                    s.endTime    = static_cast<double> (seg.getProperty ("endTime", 0.0));
                                    s.pitchRatio = static_cast<float> (static_cast<double> (seg.getProperty ("pitchRatio", 1.0)));
                                    previewData.pitchSegments.push_back (s);
                                }
                            }

                            if (previewObj != nullptr)
                            {
                                if (previewObj->hasProperty ("globalFormantSemitones"))
                                    previewData.globalFormantSemitones = static_cast<float> (static_cast<double> (previewObj->getProperty ("globalFormantSemitones")));
                                if (previewObj->hasProperty ("previewStartSec"))
                                    previewData.previewStartSec = static_cast<double> (previewObj->getProperty ("previewStartSec"));
                                if (previewObj->hasProperty ("previewEndSec"))
                                    previewData.previewEndSec = static_cast<double> (previewObj->getProperty ("previewEndSec"));
                                if (previewObj->hasProperty ("allowReplacingCorrectedSource"))
                                    previewData.allowReplacingCorrectedSource = static_cast<bool> (previewObj->getProperty ("allowReplacingCorrectedSource"));
                            }

                            logPitchEditorFormant ("setClipPitchPreview clip=" + clipId
                                + " pitchSegments=" + juce::String (static_cast<int> (previewData.pitchSegments.size()))
                                + " globalFormantSt=" + juce::String (previewData.globalFormantSemitones, 3)
                                + " allowReplacingCorrectedSource=" + juce::String (previewData.allowReplacingCorrectedSource ? "true" : "false")
                                + " window=[" + juce::String (previewData.previewStartSec, 3)
                                + "," + juce::String (previewData.previewEndSec, 3) + "]");

                            audioEngine.getPlaybackEngine().setClipPitchPreview (clipId, previewData);
                            completion (true);
                        }
                        else
                            completion (false);
                    })
                    .withNativeFunction ("clearClipPitchPreview", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                        {
                            audioEngine.getPlaybackEngine().clearClipPitchPreview (args[0].toString());
                            completion (true);
                        }
                        else
                            completion (false);
                    })
                    .withNativeFunction ("clearClipRenderedPreviewSegments", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                        {
                            audioEngine.getPlaybackEngine().clearClipRenderedPreviewSegments (args[0].toString());
                            completion (true);
                        }
                        else
                            completion (false);
                    })
                    .withNativeFunction ("clearAllPitchPreviewRoutes", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        audioEngine.getPlaybackEngine().clearAllPitchPreviewRoutes (args.size() >= 1 ? args[0].toString() : juce::String());
                        completion (true);
                    })
                    .withNativeFunction ("cancelPitchCorrectionRequests", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.isEmpty())
                        {
                            completion (false);
                            return;
                        }

                        const auto clipId = args[0].toString();
                        const juce::File authoritativeFile (args.size() >= 2 ? args[1].toString() : juce::String());
                        {
                            // The same lock is held by the render commit callback. Therefore
                            // cancellation either wins before a stale swap, or restores the
                            // authoritative frontend source after a swap that just completed.
                            const juce::ScopedLock sl (pitchCorrectionJobLock);
                            ++previewRenderGeneration;
                            ++noteRenderGeneration;
                            ++fullClipRenderGeneration;
                            activePreviewRequestGroup = {};
                            activeNoteRenderRequestGroup = {};
                            activeFullClipRequestGroup = {};

                            auto& playbackEngine = audioEngine.getPlaybackEngine();
                            playbackEngine.clearAllPitchPreviewRoutes (clipId);
                            playbackEngine.cancelDeferredClipAudioFile (clipId);
                            if (authoritativeFile.existsAsFile())
                                playbackEngine.replaceClipAudioFile (clipId, authoritativeFile);
                        }

                        pitchNoteHqPriorityActive.store (false);
                        previewSegmentPool.removeAllJobs (false, 0);
                        noteRenderPool.removeAllJobs (false, 0);
                        fullClipHQPool.removeAllJobs (false, 0);
                        logPitchEditorFormant ("cancelled pitch correction requests clip=" + clipId
                            + " authoritativeFile=" + authoritativeFile.getFullPathName());
                        completion (true);
                    })
                    .withNativeFunction ("clearPitchPreviewRoutesForCorrectedSources", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion (audioEngine.getPlaybackEngine().clearPitchPreviewRoutesForCorrectedSources());
                    })
                    .withNativeFunction ("separateStems", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.separateStems(args[0].toString(), args[1].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("isStemSeparationAvailable", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(audioEngine.isStemSeparationAvailable());
                    })
                    .withNativeFunction ("getAiToolsStatus", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(audioEngine.getAiToolsStatus());
                    })
                    .withNativeFunction ("refreshAiToolsStatus", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(audioEngine.refreshAiToolsStatus());
                    })
                    .withNativeFunction ("installAiTools", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() > 0 && args[0].isString())
                        {
                            completion(audioEngine.installAiTools(args[0].toString()));
                            return;
                        }

                        const bool userConfirmedDownload = args.size() > 0 && static_cast<bool>(args[0]);
                        completion(audioEngine.installAiTools(userConfirmedDownload));
                    })
                    .withNativeFunction ("resetAiTools", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(audioEngine.resetAiTools());
                    })
                    .withNativeFunction ("separateStemsAsync", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 3)
                            completion(audioEngine.separateStemsAsync(args[0].toString(), args[1].toString(), args[2].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("getStemSeparationProgress", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(audioEngine.getStemSeparationProgress());
                    })
                    .withNativeFunction ("cancelStemSeparation", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        audioEngine.cancelStemSeparation();
                        completion(juce::var());
                    })
                    .withNativeFunction ("cancelAiToolsInstall", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        audioEngine.cancelAiToolsInstall();
                        completion(juce::var());
                    })
                    .withNativeFunction ("startAIGeneration", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 4)
                            completion(audioEngine.startAIGeneration(args[0].toString(), args[1].toString(), args[2].toString(), args[3].toString()));
                        else if (args.size() >= 3)
                            completion(audioEngine.startAIGeneration(args[0].toString(), "ace-step-v15-xl-turbo", args[1].toString(), args[2].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("getAIGenerationProgress", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(audioEngine.getAIGenerationProgress());
                    })
                    .withNativeFunction ("cancelAIGeneration", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        audioEngine.cancelAIGeneration();
                        completion(juce::var());
                    })
                    .withNativeFunction ("initializeARA", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.initializeARAForTrack(args[0].toString(), static_cast<int>(args[1])));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("addARAClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.addARAClip(args[0].toString(), args[1].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("removeARAClip", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 2)
                            completion(audioEngine.removeARAClip(args[0].toString(), args[1].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("getARAStatus", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            completion(audioEngine.getARAStatusForTrack(args[0].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("shutdownARA", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            completion(audioEngine.shutdownARAForTrack(args[0].toString()));
                        else
                            completion(juce::var());
                    })
                    .withNativeFunction ("isARAActive", [this] (const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        if (args.size() >= 1)
                            completion(juce::var(audioEngine.isARAActiveForTrack(args[0].toString())));
                        else
                            completion(juce::var(false));
                    })
                    .withNativeFunction ("hasAnyActiveARA", [this] (const juce::Array<juce::var>&, juce::WebBrowserComponent::NativeFunctionCompletion completion) {
                        completion(juce::var(audioEngine.hasAnyActiveARA()));
                    }))
{
    const auto preferredBackend = getPreferredBrowserBackend();
    const auto startupLogFile = getStartupLogFile();
    const auto packagedFrontend = getPackagedFrontendEntryPoint();
    const auto webViewUserDataDir = getWebView2UserDataFolder();

    const auto checkOptions = getEmbeddedBrowserBaseOptions();
    const bool supported = juce::WebBrowserComponent::areOptionsSupported(checkOptions);
    const auto dependencyStatus = evaluateStartupDependencies(supported);

    juce::Logger::writeToLog("=== Embedded UI startup diagnostics ===");
    juce::Logger::writeToLog("Browser backend: " + describeBrowserBackend(preferredBackend));
    juce::Logger::writeToLog("Frontend startup mode: " + juce::String(startupMode == StartupMode::safe ? "safe" : "normal"));
    juce::Logger::writeToLog("Embedded browser backend supported: " + juce::String(supported ? "Yes" : "No"));
    juce::Logger::writeToLog("Startup log file: " + startupLogFile.getFullPathName());
    juce::Logger::writeToLog("Executable directory: " + getExecutableDirectory().getFullPathName());
    juce::Logger::writeToLog("Packaged frontend found: " + juce::String(packagedFrontend.existsAsFile() ? "Yes" : "No"));
    if (packagedFrontend.existsAsFile())
        juce::Logger::writeToLog("Packaged frontend path: " + packagedFrontend.getFullPathName());
    else
        juce::Logger::writeToLog("Packaged frontend candidates:\n" + describeCandidatePaths());
    juce::Logger::writeToLog("Shell runtime assets present: " + juce::String(dependencyStatus.shellRuntimeAssetsPresent ? "Yes" : "No"));
    if (! dependencyStatus.shellRuntimeAssetsPresent)
        juce::Logger::writeToLog("Missing shell runtime assets:\n" + formatMissingRuntimeAssets(dependencyStatus.missingShellRuntimeAssets));
    juce::Logger::writeToLog("Bundled feature assets present: " + juce::String(dependencyStatus.featureRuntimeAssetsPresent ? "Yes" : "No"));
    if (! dependencyStatus.featureRuntimeAssetsPresent)
        juce::Logger::writeToLog("Missing bundled feature assets:\n" + formatMissingRuntimeAssets(dependencyStatus.missingFeatureRuntimeAssets));
    juce::Logger::writeToLog("WebView2 user data path: " + webViewUserDataDir.getFullPathName());
#if JUCE_WINDOWS
    const auto webView2RuntimeVersion = detectWebView2RuntimeVersion();
    juce::Logger::writeToLog("Detected WebView2 runtime version: " + (webView2RuntimeVersion.isNotEmpty() ? webView2RuntimeVersion : "not found"));
    juce::Logger::writeToLog("VC++ Redistributable installed: " + juce::String(dependencyStatus.vcRedistInstalled ? "Yes" : "No"));
    if (dependencyStatus.vcRedistVersion.isNotEmpty())
        juce::Logger::writeToLog("Detected VC++ Redistributable version: " + dependencyStatus.vcRedistVersion);
    juce::Logger::writeToLog("Windows prerequisite repair available: " + juce::String(dependencyStatus.repairAvailable ? "Yes" : "No"));
#endif

    fallbackMessage.setJustificationType(juce::Justification::centred);
    fallbackMessage.setColour(juce::Label::textColourId, juce::Colours::white);
    fallbackMessage.setColour(juce::Label::backgroundColourId, juce::Colour(0xff111827));
    fallbackMessage.setFont(juce::Font(juce::FontOptions(16.0f)));
    fallbackMessage.setText({}, juce::dontSendNotification);
    fallbackMessage.setVisible(false);

    startupStatusMessage.setJustificationType(juce::Justification::centred);
    startupStatusMessage.setColour(juce::Label::textColourId, juce::Colours::white);
    startupStatusMessage.setColour(juce::Label::backgroundColourId, juce::Colour(0xf0111827));
    startupStatusMessage.setFont(juce::Font(juce::FontOptions(16.0f)));
    startupStatusMessage.setText({}, juce::dontSendNotification);
    startupStatusMessage.setVisible(false);
    startupStatusMessage.setInterceptsMouseClicks(false, false);

    const auto configureActionButton = [] (juce::TextButton& button)
    {
        button.setColour(juce::TextButton::buttonColourId, juce::Colour(0xff1f2937));
        button.setColour(juce::TextButton::buttonOnColourId, juce::Colour(0xff2563eb));
        button.setColour(juce::TextButton::textColourOffId, juce::Colours::white);
        button.setColour(juce::TextButton::textColourOnId, juce::Colours::white);
        button.setVisible(false);
    };

    configureActionButton(startupRetryButton);
    configureActionButton(startupOpenLogButton);
    configureActionButton(startupSafeModeButton);
    configureActionButton(startupRepairButton);

    startupRetryButton.onClick = [this]() { relaunchApplication(startupMode); };
    startupOpenLogButton.onClick = [this]() { openStartupLogFolder(); };
    startupSafeModeButton.onClick = [this]() { relaunchApplication(StartupMode::safe); };
    startupRepairButton.onClick = [this]()
    {
        if (startupRepairAction == StartupRepairAction::installation)
            repairInstalledApplication();
        else if (startupRepairAction == StartupRepairAction::dependencies)
            repairWindowsPrerequisites();
    };

    if (supported && dependencyStatus.shellRuntimeAssetsPresent)
    {
        addAndMakeVisible (webView);
        addAndMakeVisible (startupStatusMessage);
    }
    else if (! dependencyStatus.shellRuntimeAssetsPresent)
    {
        auto message = "OpenStudio is missing required shell files and cannot start safely."
                       "\n\nMissing items:\n" + formatMissingRuntimeAssets(dependencyStatus.missingShellRuntimeAssets)
                       + "\n\nStartup log: " + startupLogFile.getFullPathName();
        juce::Logger::writeToLog("Shell runtime assets are missing. Falling back to recovery screen.");
        startupRepairAction = StartupRepairAction::installation;
        showStartupFallback("Required shell assets missing", message, true);
    }
    else
    {
        juce::Logger::writeToLog("Embedded browser backend is not available. Falling back to an error screen.");
        juce::String message = "OpenStudio could not start its embedded interface on this system.";
#if JUCE_WINDOWS
        if (! dependencyStatus.vcRedistInstalled && webView2RuntimeVersion.isEmpty())
            message << "\n\nMicrosoft Visual C++ Redistributable and Microsoft Edge WebView2 Runtime were not detected.";
        else if (! dependencyStatus.vcRedistInstalled)
            message << "\n\nMicrosoft Visual C++ Redistributable was not detected on this system.";
        else if (webView2RuntimeVersion.isEmpty())
            message << "\n\nMicrosoft Edge WebView2 Runtime was not detected. Install or repair WebView2 Runtime, then relaunch OpenStudio.";
        else
            message << "\n\nOpenStudio selected the WebView2 backend, and WebView2 Runtime " << webView2RuntimeVersion
                    << " was detected, but JUCE reported the browser backend as unavailable on this machine.";
        startupRepairAction = dependencyStatus.repairAvailable ? StartupRepairAction::dependencies : StartupRepairAction::none;
#else
        message << "\n\nOpenStudio could not access the system browser backend on this macOS installation.";
        startupRepairAction = StartupRepairAction::none;
#endif
        message << "\n\nStartup log: " << startupLogFile.getFullPathName();
        showStartupFallback("Embedded browser backend unavailable", message, startupRepairAction != StartupRepairAction::none);
    }

    if (supported && dependencyStatus.shellRuntimeAssetsPresent)
    {
        bool loadedFrontend = false;

       #if JUCE_DEBUG
        if (isLocalFrontendDevServerReachable())
        {
            const auto frontendUrl = appendFrontendStartupQuery("http://127.0.0.1:5183", windowRole, startupMode, windowInstanceId);
            juce::Logger::writeToLog("Loading frontend from 127.0.0.1:5183");
            beginFrontendStartupWatchdog(frontendUrl);
            webView.goToURL(frontendUrl);
            loadedFrontend = true;
        }
        else
        {
            juce::Logger::writeToLog("127.0.0.1:5183 is unreachable; falling back to the packaged frontend.");
        }
       #endif

        if (! loadedFrontend)
        {
            if (loadPackagedFrontend())
            {
                loadedFrontend = true;
            }
            else
            {
                auto message = "OpenStudio could not find its packaged frontend.\n\nBuild the React app and ship the `webui` folder with the application."
                               "\n\nChecked paths:\n" + describeCandidatePaths()
                               + "\n\nStartup log: " + startupLogFile.getFullPathName();
                juce::Logger::writeToLog(message);
                startupRepairAction = StartupRepairAction::installation;
                showStartupFallback("Packaged frontend missing", message, true);
            }
        }
    }

    addAndMakeVisible(startupRetryButton);
    addAndMakeVisible(startupOpenLogButton);
    addAndMakeVisible(startupSafeModeButton);
    addAndMakeVisible(startupRepairButton);
    updateStartupFallbackActions();

    setSize (1024, 768);

    {
        const juce::ScopedLock sl(instanceListLock);
        activeInstances.add(this);
    }

#if JUCE_WINDOWS
    if (isMainWindow())
    {
        juce::Component::SafePointer<MainComponent> safeThis(this);
        juce::Timer::callAfterDelay(750, [safeThis]()
        {
            if (safeThis != nullptr)
                safeThis->installExternalMediaDropTarget();
        });
        juce::Timer::callAfterDelay(2500, [safeThis]()
        {
            if (safeThis != nullptr)
                safeThis->installExternalMediaDropTarget();
        });
    }
#endif

    initializePitchRegressionJob(pitchRegressionJobPathIn);

    if (isMainWindow() && pitchRegressionJob.isVoid())
        juce::Timer::callAfterDelay(2000, [this]()
    {
        appUpdater.checkForUpdates(false, [this](const juce::var& status)
        {
            if (getStringProperty(status, "status") != "update-available")
                return;

            const auto version = getStringProperty(status, "version");
            const auto notes = getStringProperty(status, "notes");
            const auto downloadUrl = getStringProperty(status, "downloadUrl");
            const auto sha256 = getStringProperty(status, "sha256");
            const auto releasePageUrl = getStringProperty(status, "releasePageUrl");
            const auto installerArguments = getStringProperty(status, "installerArguments");
            const auto expectedSize = status.hasProperty("size") ? static_cast<juce::int64>(status.getProperty("size", 0)) : 0;
            const auto mandatory = status.hasProperty("mandatory") ? static_cast<bool>(status.getProperty("mandatory", false)) : false;

            auto prompt = mandatory
                ? "A required OpenStudio update is available: " + version + "."
                : "OpenStudio " + version + " is available.";
            if (notes.isNotEmpty())
                prompt += "\n\nRelease notes:\n" + notes.substring(0, 600);

            if (juce::AlertWindow::showOkCancelBox(juce::AlertWindow::InfoIcon,
                                                   "Update Available",
                                                   prompt,
                                                   "Download",
                                                   "Later"))
            {
                appUpdater.downloadAndInstallUpdate(downloadUrl, version, sha256, releasePageUrl, installerArguments, expectedSize);
            }
        });
    });
    
    startTimerHz (10); // Start metering loop at 10 FPS (was 30)
    juce::Logger::writeToLog("MainComponent initialized successfully");
}

void MainComponent::initializePitchRegressionJob(const juce::String& pitchRegressionJobPathIn)
{
    if (! isMainWindow())
        return;

    const auto trimmedPath = pitchRegressionJobPathIn.trim().unquoted();
    if (trimmedPath.isEmpty())
        return;

    pitchRegressionJobFile = juce::File(trimmedPath);
    if (! pitchRegressionJobFile.existsAsFile())
    {
        juce::Logger::writeToLog("[pitchRegression] Job file not found: " + pitchRegressionJobFile.getFullPathName());
        return;
    }

    const auto parsedJob = juce::JSON::parse(pitchRegressionJobFile);
    if (parsedJob.isVoid())
    {
        juce::Logger::writeToLog("[pitchRegression] Failed to parse job JSON: " + pitchRegressionJobFile.getFullPathName());
        pitchRegressionJobFile = juce::File();
        return;
    }

    pitchRegressionJob = parsedJob;
    lastPitchRegressionNativeResult = juce::var();
    juce::Logger::writeToLog("[pitchRegression] Loaded job file: " + pitchRegressionJobFile.getFullPathName());
}

bool MainComponent::completePitchRegressionJob(const juce::var& result)
{
    if (! isMainWindow() || pitchRegressionJob.isVoid() || pitchRegressionJobCompleted)
        return false;

    const auto resultPath = getStringProperty(pitchRegressionJob, "resultJsonPath").trim();
    if (resultPath.isEmpty())
    {
        juce::Logger::writeToLog("[pitchRegression] Missing resultJsonPath in job payload.");
        return false;
    }

    auto payload = result;
    if (! payload.isObject())
    {
        auto* fallback = new juce::DynamicObject();
        fallback->setProperty("success", false);
        fallback->setProperty("error", "Regression frontend returned a non-object result.");
        payload = juce::var(fallback);
    }

    auto* payloadObject = payload.getDynamicObject();
    if (payloadObject == nullptr)
        return false;

    juce::var nativeResultSnapshot;
    {
        const juce::ScopedLock resultLock (pitchRegressionNativeResultLock);
        nativeResultSnapshot = lastPitchRegressionNativeResult;
    }

    if (nativeResultSnapshot.isObject())
    {
        auto mergeFromNative = [payloadObject, &nativeResultSnapshot] (const juce::Identifier& propertyName, bool overwriteExisting)
        {
            if (! overwriteExisting)
            {
                const auto currentValue = payloadObject->getProperty (propertyName);
                const bool missingValue = currentValue.isVoid()
                    || (currentValue.isString() && currentValue.toString().isEmpty());
                if (! missingValue)
                    return;
            }

            const auto mergedValue = nativeResultSnapshot.getProperty (propertyName, juce::var());
            if (mergedValue.isVoid())
                return;
            payloadObject->setProperty (propertyName, mergedValue);
        };

        mergeFromNative ("requestedRendererBranch", true);
        mergeFromNative ("actualRendererBranch", true);
        mergeFromNative ("pitchOnlyRecoveryPath", true);
        mergeFromNative ("pitchOnlyNeutralFormantUsed", true);
        mergeFromNative ("processingMode", true);
        mergeFromNative ("formantCurveUsed", true);
        mergeFromNative ("explicitFormantRequested", true);
        mergeFromNative ("pitchOnlyFormantSuppressed", true);
        mergeFromNative ("usedFallback", true);
        mergeFromNative ("fallbackReason", true);
        mergeFromNative ("hardFailReason", true);
        mergeFromNative ("pitchRenderStrategy", true);
        mergeFromNative ("phraseHqRenderUsed", true);
        mergeFromNative ("phraseHqExpandedToFullClip", true);
        mergeFromNative ("phraseHqStartSec", true);
        mergeFromNative ("phraseHqEndSec", true);
        mergeFromNative ("pitchRenderProductPath", true);
        mergeFromNative ("pitchRenderBackendId", true);
        mergeFromNative ("pitchRenderBackendVersion", true);
        mergeFromNative ("pitchRenderBackendFailureCode", true);
        mergeFromNative ("pitchRenderBackendCapabilities", true);
        mergeFromNative ("pitchRenderBackendDiagnostics", true);
        mergeFromNative ("pitchRenderCommitPolicy", true);
        mergeFromNative ("pitchRenderDryProtectedSamples", true);
        mergeFromNative ("pitchRenderContextDurationSec", true);
        mergeFromNative ("pitchRenderCommitDurationSec", true);
        mergeFromNative ("pitchRenderJobStartDelayMs", true);
        mergeFromNative ("pitchRenderDirection", true);
        mergeFromNative ("downshiftFormantGuardUsed", true);
        mergeFromNative ("downshiftFormantGuardAlpha", true);
        mergeFromNative ("noteHqEffectiveStartSec", true);
        mergeFromNative ("noteHqEffectiveEndSec", true);
        mergeFromNative ("noteHqContextStartSec", true);
        mergeFromNative ("noteHqContextEndSec", true);
        mergeFromNative ("noteHqAudibleCommitStartSec", true);
        mergeFromNative ("noteHqAudibleCommitEndSec", true);
        mergeFromNative ("noteHqPreBodyDryProtectedSamples", true);
        mergeFromNative ("noteHqEntryInsideBodyFadeMs", true);
        mergeFromNative ("noteHqExitLeadInMs", true);
        mergeFromNative ("noteHqEntryBridgeStartSec", true);
        mergeFromNative ("noteHqEntryBridgeEndSec", true);
        mergeFromNative ("noteHqEntryBridgeWetLagMs", true);
        mergeFromNative ("noteHqEntryBridgeEnvelopeGainDb", true);
        mergeFromNative ("noteHqEntryBridgeUsed", true);
        mergeFromNative ("noteHqEntryTransientDryPreservedMs", true);
        mergeFromNative ("pitchOnlyEntrySimpleHandoffUsed", true);
        mergeFromNative ("pitchOnlyEntrySafeHandoffUsed", true);
        mergeFromNative ("pitchOnlyEntryDryHoldMs", true);
        mergeFromNative ("pitchOnlyEntrySafeBridgeMs", true);
        mergeFromNative ("pitchOnlyEntryWetAlignmentMs", true);
        mergeFromNative ("pitchOnlyEntryWetGainDb", true);
        mergeFromNative ("pitchOnlyEntryWetVsDryRmsDb", true);
        mergeFromNative ("pitchOnlyEntryEqualPowerBlendUsed", true);
        mergeFromNative ("pitchOnlyEntryRmsContinuityUsed", true);
        mergeFromNative ("pitchOnlyEntryRmsContinuityGainDb", true);
        mergeFromNative ("pitchOnlyEntryRmsContinuityMs", true);
        mergeFromNative ("pitchOnlyEntryPhaseSafeUsed", true);
        mergeFromNative ("pitchOnlyEntryWetAlignmentAccepted", true);
        mergeFromNative ("pitchOnlyEntryFirstCycleCorrelation", true);
        mergeFromNative ("pitchOnlyEntryZeroCrossOffsetMs", true);
        mergeFromNative ("pitchOnlyEntryBridgeGainRampDb", true);
        mergeFromNative ("pitchOnlyDownshiftCoreEnvelopePassUsed", true);
        mergeFromNative ("pitchOnlyDownshiftCoreRmsTrimDb", true);
        mergeFromNative ("pitchOnlyDownshiftCoreEnvelopeMaxDb", true);
        mergeFromNative ("pitchOnlyDownshiftCoreEnvelopeFrames", true);
        mergeFromNative ("pitchOnlyEntryWetLagMs", true);
        mergeFromNative ("pitchOnlyEntryBridgeDurationMs", true);
        mergeFromNative ("pitchOnlyExitDryRestoreUsed", true);
        mergeFromNative ("pitchOnlyExitDryRestoreStartSec", true);
        mergeFromNative ("pitchOnlyExitDryRestoreEndSec", true);
        mergeFromNative ("noteHqEditIslandCount", true);
        mergeFromNative ("noteHqEditedNoteCount", true);
        mergeFromNative ("noteHqEntryPitchHandoffUsed", true);
        mergeFromNative ("noteHqEntryPitchHandoffStartSec", true);
        mergeFromNative ("noteHqEntryPitchHandoffEndSec", true);
        mergeFromNative ("noteHqEntryPitchHandoffPreMs", true);
        mergeFromNative ("noteHqEntryPitchHandoffBodyMs", true);
        mergeFromNative ("noteHqEntryPitchSlopeJumpStPerSec", true);
        mergeFromNative ("noteHqEntryPitchAccelerationLimited", true);
        mergeFromNative ("outputDurationSec", true);
        mergeFromNative ("postApplyRouteStatus", true);
        mergeFromNative ("appFinalCapture", true);
        mergeFromNative ("appFinalBakedCapture", true);
        mergeFromNative ("appFinalParityReport", true);
        mergeFromNative ("appFinalRouteReportPath", true);
        mergeFromNative ("appFinalBakedContextPath", true);
        mergeFromNative ("appFinalPlaybackContextPath", true);
        mergeFromNative ("appFinalParityReportPath", true);
        mergeFromNative ("bridgeUsed", true);
        mergeFromNative ("bridgeFallbackUsed", true);
        mergeFromNative ("bridgeStartSec", true);
        mergeFromNative ("bridgeLengthMs", true);
        mergeFromNative ("bridgeAlignmentLagSamples", true);
        mergeFromNative ("bridgeCorrelationScore", true);
        mergeFromNative ("bridgeGainDeltaDb", true);
        mergeFromNative ("bodyReplacementUsed", true);
        mergeFromNative ("bodyReplacementFallbackUsed", true);
        mergeFromNative ("entryLockStartSec", true);
        mergeFromNative ("entryLockLengthMs", true);
        mergeFromNative ("exitLockStartSec", true);
        mergeFromNative ("renderedBodyStartSec", true);
        mergeFromNative ("renderedBodyEndSec", true);
        mergeFromNative ("islandNativeUsed", true);
        mergeFromNative ("islandNativeFallbackUsed", true);
        mergeFromNative ("islandRenderStartSec", true);
        mergeFromNative ("islandRenderEndSec", true);
        mergeFromNative ("transientMaskPeak", true);
        mergeFromNative ("voicedCoreMaskPeak", true);
        mergeFromNative ("hpssUsed", true);
        mergeFromNative ("hpssFallbackUsed", true);
        mergeFromNative ("harmonicMaskPeak", true);
        mergeFromNative ("aperiodicMaskPeak", true);
        mergeFromNative ("spectralEnvelopeCorrectionUsed", true);
        mergeFromNative ("pitchOnlyCoreTimbreCorrectionUsed", true);
        mergeFromNative ("pitchOnlyCoreEnvelopeMix", true);
        mergeFromNative ("pitchOnlyCoreRmsTrimDb", true);
        mergeFromNative ("pitchOnlyCoreEnvelopeLifter", true);
        mergeFromNative ("pitchOnlyEntryTimbreCorrectionUsed", true);
        mergeFromNative ("pitchOnlyEntryRmsTrimDb", true);
        mergeFromNative ("pitchOnlyEntryTiltDb", true);
        mergeFromNative ("pitchOnlyEntryHandoffUsed", true);
        mergeFromNative ("pitchOnlyExitHandoffUsed", true);
        mergeFromNative ("vocalSourceFilterUsed", true);
        mergeFromNative ("vocalSourceFilterVoicedCoverage", true);
        mergeFromNative ("vocalSourceFilterResidualMix", true);
        mergeFromNative ("vocalSourceFilterFallbackUsed", true);
        mergeFromNative ("vocalSourceFilterFallbackReason", true);
        mergeFromNative ("vocalSourceFilterEntryDryMs", true);
        mergeFromNative ("vocalSourceFilterExitDryMs", true);
        mergeFromNative ("wsolaUsed", true);
        mergeFromNative ("wsolaFallbackUsed", true);
        mergeFromNative ("wsolaEntryLagSamples", true);
        mergeFromNative ("wsolaExitLagSamples", true);
        mergeFromNative ("wsolaCorrelationScore", true);
        mergeFromNative ("phaseLockUsed", true);
        mergeFromNative ("phaseLockFallbackUsed", true);
        mergeFromNative ("phaseAlignedEntry", true);
        mergeFromNative ("phaseAlignedExit", true);
        mergeFromNative ("phasePeakCount", true);
        mergeFromNative ("transitionHqUsed", true);
        mergeFromNative ("transitionHqFallbackUsed", true);
        mergeFromNative ("transitionStartSec", true);
        mergeFromNative ("transitionEndSec", true);
        mergeFromNative ("transitionTransientPeak", true);
        mergeFromNative ("transitionVoicedCorePeak", true);
        mergeFromNative ("transitionResidualPeak", true);
        mergeFromNative ("transitionEnvelopeCorrectionUsed", true);
        mergeFromNative ("engineV2Used", true);
        mergeFromNative ("engineV2FallbackUsed", true);
        mergeFromNative ("engineV2TransitionCount", true);
        mergeFromNative ("engineV2TransitionStartSec", true);
        mergeFromNative ("engineV2TransitionEndSec", true);
        mergeFromNative ("engineV2HarmonicSupportPeak", true);
        mergeFromNative ("engineV2ResidualSupportPeak", true);
        mergeFromNative ("engineV2EnvelopeSupportPeak", true);
        mergeFromNative ("previewCoverageStartSec", true);
        mergeFromNative ("previewCoverageEndSec", true);
        mergeFromNative ("candidateCoverageStartSec", true);
        mergeFromNative ("candidateCoverageEndSec", true);
    }

    payloadObject->setProperty("jobPath", pitchRegressionJobFile.getFullPathName());
    payloadObject->setProperty("completedAt", juce::Time::getCurrentTime().toISO8601(true));

    const auto outputFile = juce::File(resultPath);
    outputFile.getParentDirectory().createDirectory();
    const auto writeOk = outputFile.replaceWithText(juce::JSON::toString(payload, true));
    pitchRegressionJobCompleted = writeOk;
    juce::Logger::writeToLog("[pitchRegression] Wrote result to: " + outputFile.getFullPathName()
                             + " success=" + juce::String(writeOk ? "true" : "false"));

    if (auto* app = juce::JUCEApplication::getInstance())
    {
        const auto success = writeOk && static_cast<bool>(payloadObject->getProperty("success"));
        app->setApplicationReturnValue(success ? 0 : 1);
        juce::Timer::callAfterDelay(100, []()
        {
            if (auto* currentApp = juce::JUCEApplication::getInstance())
                currentApp->systemRequestedQuit();
        });
    }

    return writeOk;
}

MainComponent::~MainComponent()
{
    if (! isMainWindow())
        prepareForSecondaryWindowClose();

    stopTimer();
    ++pitchAnalysisGeneration;
    ++previewRenderGeneration;
    ++noteRenderGeneration;
    ++fullClipRenderGeneration;
    pitchAnalysisRunning.store(false);
    pitchNoteHqPriorityActive.store(false);
    builtInStateMutationPool.removeAllJobs(true, -1);
    pitchAnalysisPool.removeAllJobs(true, 5000);
    previewSegmentPool.removeAllJobs(true, 5000);
    noteRenderPool.removeAllJobs(true, 5000);
    fullClipHQPool.removeAllJobs(true, 5000);
    polyAnalysisBridgePool.removeAllJobs(true, 5000);
    mediaPreviewPool.removeAllJobs(true, 2000);
#if JUCE_WINDOWS
    externalMediaDropTarget.reset();
#endif
    const juce::ScopedLock sl(instanceListLock);
    activeInstances.removeFirstMatchingValue(this);
}

void MainComponent::prepareForSecondaryWindowClose()
{
    if (isMainWindow() || secondaryWindowClosing)
        return;

    secondaryWindowClosing = true;
    startupWatchdogActive = false;
    frontendStartupDetail = "Secondary window is closing.";
    stopTimer();

    ++pitchAnalysisGeneration;
    ++previewRenderGeneration;
    ++noteRenderGeneration;
    ++fullClipRenderGeneration;
    pitchAnalysisRunning.store(false);
    pitchNoteHqPriorityActive.store(false);

    hideStartupOverlay();
    fallbackMessage.setVisible(false);
    hideStartupFallbackActions();

    webView.setVisible(false);
    webView.stop();

    juce::Logger::writeToLog("Secondary MainComponent shutdown prepared: role="
                             + getWindowRoleQueryValue(windowRole)
                             + (windowInstanceId.isNotEmpty() ? " sessionId=" + windowInstanceId : juce::String()));
}

bool MainComponent::hasFrontendStartupReachedTerminalState() const
{
    return frontendStartupState == FrontendStartupState::ready
        || frontendStartupState == FrontendStartupState::failed
        || frontendStartupState == FrontendStartupState::timedOut;
}

bool MainComponent::hasFrontendStartupSucceeded() const
{
    return frontendStartupState == FrontendStartupState::ready;
}

juce::String MainComponent::getFrontendStartupStateDescription() const
{
    return describeFrontendStartupState(frontendStartupState);
}

#if JUCE_WINDOWS
void MainComponent::emitExternalMediaDropTargetEvent(const juce::String& eventId, const juce::var& payload)
{
    emitFrontendEvent(eventId, payload);
}

void MainComponent::bringMainWindowToFrontForExternalMediaDrag()
{
    if (! isMainWindow())
        return;

    auto* peer = getPeer();
    if (peer == nullptr)
        return;

    auto hwnd = static_cast<HWND>(peer->getNativeHandle());
    if (hwnd == nullptr || ! ::IsWindow(hwnd))
        return;

    if (::IsIconic(hwnd))
        ::ShowWindow(hwnd, SW_RESTORE);

    ::SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
                   SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    ::BringWindowToTop(hwnd);
    ::SetForegroundWindow(hwnd);
}

void MainComponent::installExternalMediaDropTarget()
{
    if (! isMainWindow())
        return;

    auto* peer = getPeer();
    if (peer == nullptr)
        return;

    if (externalMediaDropTarget == nullptr)
        externalMediaDropTarget = std::make_unique<ExternalMediaDropTarget>(*this);

    auto hwnd = static_cast<HWND>(peer->getNativeHandle());
    externalMediaDropTarget->registerWindow(hwnd);
    if (hwnd != nullptr)
    {
        ::EnumChildWindows(hwnd, [](HWND child, LPARAM param) -> BOOL
        {
            auto* self = reinterpret_cast<MainComponent*>(param);
            if (self != nullptr && self->externalMediaDropTarget != nullptr)
                self->externalMediaDropTarget->registerWindow(child);
            return TRUE;
        }, reinterpret_cast<LPARAM>(this));
    }
}

bool MainComponent::isWaveformPreviewRequestCancelled(const juce::String& requestId) const
{
    const juce::ScopedLock sl(waveformPreviewRequestLock);
    return cancelledWaveformPreviewRequests.count(requestId) != 0;
}
#endif

void MainComponent::requestFrontendAppClose()
{
    if (! isMainWindow())
    {
        if (windowRole == WindowRole::midiEditor && windowCallbacks.closeMidiEditorWindow)
        {
            auto closeMidiEditorWindow = windowCallbacks.closeMidiEditorWindow;
            const auto sessionId = windowInstanceId.isNotEmpty() ? windowInstanceId : juce::String("default-midi-editor");
            juce::MessageManager::callAsync([closeMidiEditorWindow, sessionId]()
            {
                closeMidiEditorWindow(sessionId, "close");
            });
        }
        else if (windowRole == WindowRole::pluginEditor && windowCallbacks.closePluginEditorWindow)
        {
            auto closePluginEditorWindow = windowCallbacks.closePluginEditorWindow;
            const auto sessionId = windowInstanceId.isNotEmpty() ? windowInstanceId : juce::String("default-plugin-editor");
            juce::MessageManager::callAsync([closePluginEditorWindow, sessionId]()
            {
                closePluginEditorWindow(sessionId, "close");
            });
        }
        else if (windowCallbacks.closeMixerWindow)
        {
            auto closeMixerWindow = windowCallbacks.closeMixerWindow;
            juce::MessageManager::callAsync([closeMixerWindow]()
            {
                closeMixerWindow();
            });
        }
        return;
    }

    if (frontendStartupState == FrontendStartupState::ready)
    {
        emitFrontendEvent("appCloseRequested");
        return;
    }

    if (windowCallbacks.requestAppClose)
        windowCallbacks.requestAppClose();
    else
        juce::JUCEApplication::getInstance()->systemRequestedQuit();
}

void MainComponent::broadcastEventToAll(const juce::String& eventId, const juce::var& payload)
{
    juce::Array<MainComponent*> instancesCopy;
    {
        const juce::ScopedLock sl(instanceListLock);
        instancesCopy = activeInstances;
    }

    for (auto* instance : instancesCopy)
        if (instance != nullptr)
            instance->emitFrontendEvent(eventId, payload);
}

void MainComponent::broadcastEventToRole(WindowRole role, const juce::String& eventId, const juce::var& payload)
{
    juce::Array<MainComponent*> instancesCopy;
    {
        const juce::ScopedLock sl(instanceListLock);
        instancesCopy = activeInstances;
    }

    for (auto* instance : instancesCopy)
        if (instance != nullptr && instance->windowRole == role)
            instance->emitFrontendEvent(eventId, payload);
}

void MainComponent::emitFrontendEvent(const juce::String& eventId, const juce::var& payload)
{
    if (secondaryWindowClosing)
        return;

    if (auto* messageManager =
            juce::MessageManager::getInstanceWithoutCreating();
        messageManager != nullptr
        && messageManager->isThisTheMessageThread())
    {
        webView.emitEventIfBrowserIsVisible(
            eventId,
            payload);
        return;
    }

    juce::Component::SafePointer<MainComponent> safeThis(this);
    juce::MessageManager::callAsync([safeThis, eventId, payload]()
    {
        if (safeThis != nullptr && ! safeThis->secondaryWindowClosing)
            safeThis->webView.emitEventIfBrowserIsVisible(eventId, payload);
    });
}

bool MainComponent::isMainWindow() const
{
    return windowRole == WindowRole::main;
}

bool MainComponent::loadPackagedFrontend()
{
    if (secondaryWindowClosing)
        return false;

    const auto packagedFrontend = getPackagedFrontendEntryPoint();
    if (! packagedFrontend.existsAsFile())
        return false;

    webuiDir = packagedFrontend.getParentDirectory();
    juce::Logger::writeToLog("Loading packaged frontend from: " + packagedFrontend.getFullPathName());

    const auto frontendUrl = appendFrontendStartupQuery(
        juce::WebBrowserComponent::getResourceProviderRoot() + "index.html",
        windowRole,
        startupMode,
        windowInstanceId);
    beginFrontendStartupWatchdog(frontendUrl);
    webView.goToURL(frontendUrl);
    return true;
}

bool MainComponent::tryFallbackToPackagedFrontendAfterLocalTimeout()
{
    if (attemptedPackagedFrontendFallbackAfterLocalTimeout)
        return false;

    if (! frontendStartupTargetUrl.startsWithIgnoreCase("http://localhost:5183")
        && ! frontendStartupTargetUrl.startsWithIgnoreCase("http://127.0.0.1:5183"))
        return false;

    attemptedPackagedFrontendFallbackAfterLocalTimeout = true;

#if JUCE_DEBUG
    juce::Logger::writeToLog("Frontend startup timed out while using local Vite; "
                             "not retrying with packaged frontend in Debug mode.");
    return false;
#else
    juce::Logger::writeToLog("Frontend startup timed out while using localhost:5183; "
                             "retrying with the packaged frontend.");
    return loadPackagedFrontend();
#endif
}

void MainComponent::beginFrontendStartupWatchdog(const juce::String& targetUrl)
{
    if (secondaryWindowClosing)
    {
        juce::Logger::writeToLog("Frontend startup watchdog ignored for closing secondary window: role="
                                 + getWindowRoleQueryValue(windowRole));
        return;
    }

    frontendStartupTargetUrl = targetUrl;
    frontendStartupDetail.clear();
    frontendStartupState = FrontendStartupState::navigationStarted;
    frontendStartupNavigationTicks = 0;
    startupFallbackVisible = false;
    startupWatchdogActive = true;
    fallbackMessage.setVisible(false);
    webView.setVisible(true);
    showStartupOverlay(startupMode == StartupMode::safe ? "Starting OpenStudio Safe Mode..." : "Starting OpenStudio...",
                       "Preparing the embedded interface.\n\nStartup log: " + getStartupLogFile().getFullPathName());
    juce::Logger::writeToLog("Frontend startup state: navigation-started - " + targetUrl);
}

void MainComponent::showStartupOverlay(const juce::String& title, const juce::String& detail)
{
    startupStatusMessage.setText(title + "\n\n" + detail, juce::dontSendNotification);
    startupStatusMessage.setVisible(true);
    startupStatusMessage.toFront(false);
    resized();
}

void MainComponent::hideStartupOverlay()
{
    startupStatusMessage.setVisible(false);
}

void MainComponent::markFrontendStartupReady(const juce::String& detail)
{
    if (secondaryWindowClosing)
    {
        juce::Logger::writeToLog("Frontend startup state ignored after secondary close: boot-ready"
                                 + (detail.isNotEmpty() ? " - " + detail : ""));
        return;
    }

    if (frontendStartupState == FrontendStartupState::ready)
        return;

    frontendStartupState = FrontendStartupState::ready;
    frontendStartupDetail = detail;
    startupWatchdogActive = false;
    startupFallbackVisible = false;
    startupRepairAction = StartupRepairAction::none;
    fallbackMessage.setVisible(false);
    hideStartupFallbackActions();
    hideStartupOverlay();
    webView.setVisible(true);
    juce::Logger::writeToLog("Frontend startup state: boot-ready" + (detail.isNotEmpty() ? " - " + detail : ""));

    if (! isMainWindow())
    {
        auto* payload = new juce::DynamicObject();
        payload->setProperty("role", getWindowRoleQueryValue(windowRole));
        payload->setProperty("sessionId", windowInstanceId);
        payload->setProperty("detail", detail);
        payload->setProperty("startupState", describeFrontendStartupState(frontendStartupState));

        MainComponent::broadcastEventToRole(WindowRole::main, "secondaryWindowReady", juce::var(payload));

        auto* rolePayload = new juce::DynamicObject();
        rolePayload->setProperty("role", getWindowRoleQueryValue(windowRole));
        rolePayload->setProperty("sessionId", windowInstanceId);
        rolePayload->setProperty("detail", detail);

        if (windowRole == WindowRole::mixer)
            MainComponent::broadcastEventToRole(WindowRole::main, "mixerWindowReady", juce::var(rolePayload));
        else if (windowRole == WindowRole::midiEditor)
            MainComponent::broadcastEventToRole(WindowRole::main, "midiEditorWindowReady", juce::var(rolePayload));
        else if (windowRole == WindowRole::pluginEditor)
            MainComponent::broadcastEventToRole(WindowRole::main, "builtInPluginEditorWindowReady", juce::var(rolePayload));
        else
            delete rolePayload;
    }
}

void MainComponent::markFrontendStartupFailed(const juce::String& detail)
{
    if (secondaryWindowClosing)
    {
        juce::Logger::writeToLog("Frontend startup state ignored after secondary close: boot-failed"
                                 + (detail.isNotEmpty() ? " - " + detail : ""));
        return;
    }

    frontendStartupState = FrontendStartupState::failed;
    frontendStartupDetail = detail;
    startupWatchdogActive = false;
    juce::Logger::writeToLog("Frontend startup state: boot-failed" + (detail.isNotEmpty() ? " - " + detail : ""));
    showStartupFallback("Frontend startup failed",
                        detail + "\n\nStartup log: " + getStartupLogFile().getFullPathName(),
                        startupRepairAction != StartupRepairAction::none);
}

void MainComponent::showStartupFallback(const juce::String& title, const juce::String& detail, bool allowRepair)
{
    startupFallbackVisible = true;
    if (! allowRepair)
        startupRepairAction = StartupRepairAction::none;
    hideStartupOverlay();
    fallbackMessage.setText(title + "\n\n" + detail, juce::dontSendNotification);
    fallbackMessage.setVisible(true);
    addAndMakeVisible(fallbackMessage);
    fallbackMessage.toFront(false);
    webView.setVisible(false);
    updateStartupFallbackActions();
    resized();
}

void MainComponent::hideStartupFallbackActions()
{
    startupRetryButton.setVisible(false);
    startupOpenLogButton.setVisible(false);
    startupSafeModeButton.setVisible(false);
    startupRepairButton.setVisible(false);
}

void MainComponent::updateStartupFallbackActions()
{
    if (! startupFallbackVisible)
    {
        hideStartupFallbackActions();
        return;
    }

    startupRetryButton.setVisible(true);
    startupOpenLogButton.setVisible(true);
    startupSafeModeButton.setVisible(startupMode != StartupMode::safe);
    startupRepairButton.setVisible(startupRepairAction != StartupRepairAction::none);
    if (startupRepairAction == StartupRepairAction::installation)
        startupRepairButton.setButtonText("Repair Installation");
    else if (startupRepairAction == StartupRepairAction::dependencies)
        startupRepairButton.setButtonText("Repair Dependencies");
    else
        startupRepairButton.setButtonText("Repair");
    resized();
}

void MainComponent::openStartupLogFolder()
{
    const auto logDirectory = getStartupLogFile().getParentDirectory();
    if (logDirectory.isDirectory())
        logDirectory.revealToUser();
}

void MainComponent::relaunchApplication(StartupMode targetMode)
{
    auto arguments = juce::String();
    if (targetMode == StartupMode::safe)
        arguments = "--ui-safe-mode";

    const auto executable = juce::File::getSpecialLocation(juce::File::currentApplicationFile);
    if (executable.existsAsFile() && executable.startAsProcess(arguments))
    {
        juce::Logger::writeToLog("Restarting OpenStudio in " + getStartupModeQueryValue(targetMode) + " mode.");
        if (auto* app = juce::JUCEApplication::getInstance())
            app->systemRequestedQuit();
    }
    else
    {
        juce::Logger::writeToLog("Failed to relaunch OpenStudio in " + getStartupModeQueryValue(targetMode) + " mode.");
    }
}

void MainComponent::repairInstalledApplication()
{
#if JUCE_WINDOWS
    const auto localInstaller = getExecutableDirectory().getChildFile("OpenStudio-Setup-x64.exe");
    if (localInstaller.existsAsFile() && localInstaller.startAsProcess())
    {
        juce::AlertWindow::showMessageBoxAsync(
            juce::AlertWindow::InfoIcon,
            "Repair Installation",
            "OpenStudio launched the local installer in repair mode.\n\nComplete the installer, then relaunch OpenStudio."
        );
        return;
    }
#endif

    juce::AlertWindow::showMessageBoxAsync(
        juce::AlertWindow::WarningIcon,
        "Repair Installation",
        "OpenStudio is missing shell files. Re-run the latest OpenStudio installer to repair the installation, then relaunch the app."
    );
}

void MainComponent::repairWindowsPrerequisites()
{
#if JUCE_WINDOWS
    const auto prereqDir = getWindowsPrerequisiteInstallerDirectory();
    const auto webView2Installer = prereqDir.getChildFile("MicrosoftEdgeWebView2RuntimeInstallerX64.exe");
    const auto vcRedistInstaller = prereqDir.getChildFile("vc_redist.x64.exe");

    auto launchedInstallers = juce::StringArray();

    if (vcRedistInstaller.existsAsFile() && vcRedistInstaller.startAsProcess("/install /quiet /norestart"))
        launchedInstallers.add("Microsoft Visual C++ Redistributable");

    if (webView2Installer.existsAsFile() && webView2Installer.startAsProcess("/silent /install"))
        launchedInstallers.add("Microsoft Edge WebView2 Runtime");

    if (launchedInstallers.isEmpty())
    {
        juce::AlertWindow::showMessageBoxAsync(
            juce::AlertWindow::WarningIcon,
            "Repair Prerequisites",
            "OpenStudio could not find any local prerequisite installers in:\n"
                + prereqDir.getFullPathName()
                + "\n\nReinstall OpenStudio or rebuild the installer with prerequisite staging enabled."
        );
        return;
    }

    juce::AlertWindow::showMessageBoxAsync(
        juce::AlertWindow::InfoIcon,
        "Repair Started",
        "OpenStudio launched the following repair installers:\n - "
            + launchedInstallers.joinIntoString("\n - ")
            + "\n\nComplete any prompts, then click Retry."
    );
#else
    juce::ignoreUnused(startupRepairAction);
#endif
}

juce::var MainComponent::buildStartupDiagnostics() const
{
    const auto dependencyStatus = evaluateStartupDependencies(
        juce::WebBrowserComponent::areOptionsSupported(getEmbeddedBrowserBaseOptions()));
    auto* diagnostics = new juce::DynamicObject();
    const auto selfTestReport = buildStartupSelfTestReport();
    diagnostics->setProperty("windowRole", getWindowRoleQueryValue(windowRole));
    diagnostics->setProperty("startupMode", getStartupModeQueryValue(startupMode));
    diagnostics->setProperty("platform", getHostPlatformQueryValue());
    diagnostics->setProperty("windowChrome", getWindowChromeQueryValue(windowRole));
    diagnostics->setProperty("browserBackend", describeBrowserBackend(getPreferredBrowserBackend()));
    diagnostics->setProperty("startupState", describeFrontendStartupState(frontendStartupState));
    diagnostics->setProperty("targetUrl", frontendStartupTargetUrl);
    diagnostics->setProperty("detail", frontendStartupDetail);
    diagnostics->setProperty("startupLogPath", getStartupLogFile().getFullPathName());
    diagnostics->setProperty("packagedFrontendPath", getPackagedFrontendEntryPoint().getFullPathName());
    diagnostics->setProperty("packagedFrontendCandidates", describeCandidatePaths());
    diagnostics->setProperty("packagedFrontendPresent", dependencyStatus.packagedFrontendPresent);
    diagnostics->setProperty("shellRuntimeAssetsPresent", dependencyStatus.shellRuntimeAssetsPresent);
    diagnostics->setProperty("missingShellRuntimeAssets", dependencyStatus.missingShellRuntimeAssets.joinIntoString("\n"));
    diagnostics->setProperty("featureRuntimeAssetsPresent", dependencyStatus.featureRuntimeAssetsPresent);
    diagnostics->setProperty("missingFeatureRuntimeAssets", dependencyStatus.missingFeatureRuntimeAssets.joinIntoString("\n"));
    diagnostics->setProperty("prerequisiteRepairAvailable", dependencyStatus.repairAvailable);
    diagnostics->setProperty("startupSelfTest", selfTestReport);
    diagnostics->setProperty("webView2UserDataPath", getWebView2UserDataFolder().getFullPathName());
#if JUCE_WINDOWS
    diagnostics->setProperty("webView2RuntimeVersion", detectWebView2RuntimeVersion());
    diagnostics->setProperty("vcRedistInstalled", dependencyStatus.vcRedistInstalled);
    diagnostics->setProperty("vcRedistVersion", dependencyStatus.vcRedistVersion);
#endif
    return juce::var(diagnostics);
}

juce::Rectangle<int> MainComponent::getDesktopWorkAreaForCurrentWindow() const
{
    if (auto* topLevel = getTopLevelComponent())
    {
        const auto bounds = topLevel->getBounds();
        if (auto* display = juce::Desktop::getInstance().getDisplays().getDisplayForRect(bounds))
            return display->userBounds.getSmallestIntegerContainer();
    }

    if (auto* display = juce::Desktop::getInstance().getDisplays().getPrimaryDisplay())
        return display->userBounds.getSmallestIntegerContainer();

    return getScreenBounds();
}

bool MainComponent::isWindowPseudoMaximized() const
{
#if JUCE_WINDOWS
    if (auto* peer = getTopLevelComponent() != nullptr ? getTopLevelComponent()->getPeer() : nullptr)
    {
        if (auto* hwnd = static_cast<HWND>(peer->getNativeHandle()))
            return windowPseudoMaximized || (::IsZoomed(hwnd) != 0);
    }
#endif
    return windowPseudoMaximized;
}

void MainComponent::restoreDesktopWindow(const juce::Rectangle<int>& targetBounds)
{
    if (auto* topLevel = getTopLevelComponent())
    {
#if JUCE_WINDOWS
        if (auto* peer = topLevel->getPeer())
        {
            if (auto* hwnd = static_cast<HWND>(peer->getNativeHandle()))
            {
                if (::IsZoomed(hwnd) != 0)
                    ::ShowWindow(hwnd, SW_RESTORE);
            }
        }
#endif
        topLevel->setBounds(targetBounds);
    }
}

bool MainComponent::toggleDesktopPseudoMaximize()
{
    auto* topLevel = getTopLevelComponent();
    if (topLevel == nullptr)
        return false;

#if JUCE_WINDOWS
    if (auto* peer = topLevel->getPeer())
    {
        if (auto* hwnd = static_cast<HWND>(peer->getNativeHandle()))
        {
            if (::IsZoomed(hwnd) != 0)
            {
                auto restoreRect = getWindowRestoreBoundsFromPlacement(hwnd);
                ::ShowWindow(hwnd, SW_RESTORE);
                if (!restoreRect.isEmpty())
                    topLevel->setBounds(restoreRect);
                windowPseudoMaximized = false;
                windowRestoreBounds = restoreRect;
                return false;
            }
        }
    }
#endif

    if (windowPseudoMaximized)
    {
        if (!windowRestoreBounds.isEmpty())
            restoreDesktopWindow(windowRestoreBounds);
        windowPseudoMaximized = false;
        return false;
    }

    const auto currentBounds = topLevel->getBounds();
    const auto workArea = getDesktopWorkAreaForCurrentWindow();
    windowRestoreBounds = currentBounds;
    topLevel->setBounds(workArea);
    windowPseudoMaximized = true;
    return true;
}

void MainComponent::startDesktopWindowDrag()
{
    auto* topLevel = getTopLevelComponent();
    if (topLevel == nullptr)
        return;

#if JUCE_WINDOWS
    auto* peer = topLevel->getPeer();
    if (peer == nullptr)
        return;

    auto* hwnd = static_cast<HWND>(peer->getNativeHandle());
    if (hwnd == nullptr)
        return;

    const bool wasZoomed = (::IsZoomed(hwnd) != 0);
    const bool wasPseudoMaximized = windowPseudoMaximized;

    if (wasPseudoMaximized || wasZoomed)
    {
        POINT cursorPos {};
        ::GetCursorPos(&cursorPos);

        auto restoreBounds = windowRestoreBounds;
        if (restoreBounds.isEmpty() && wasZoomed)
            restoreBounds = getWindowRestoreBoundsFromPlacement(hwnd);
        if (restoreBounds.isEmpty())
            restoreBounds = topLevel->getBounds().withSizeKeepingCentre(1280, 800);

        const auto workArea = getDesktopWorkAreaForCurrentWindow();
        const auto referenceArea = wasPseudoMaximized ? topLevel->getBounds() : workArea;

        const double width = juce::jmax(1, referenceArea.getWidth());
        const double cursorRatio = juce::jlimit(0.0, 1.0,
            (static_cast<double>(cursorPos.x) - referenceArea.getX()) / width);

        int restoredX = static_cast<int>(std::lround(cursorPos.x - restoreBounds.getWidth() * cursorRatio));
        int restoredY = cursorPos.y - 16;

        restoreBounds.setPosition(restoredX, restoredY);
        restoreBounds = restoreBounds.constrainedWithin(workArea);

        if (wasZoomed)
            ::ShowWindow(hwnd, SW_RESTORE);

        topLevel->setBounds(restoreBounds);
        windowRestoreBounds = restoreBounds;
        windowPseudoMaximized = false;
    }

    ::ReleaseCapture();
    ::SendMessage(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
#else
    juce::ignoreUnused(topLevel);
#endif
}

//==============================================================================
void MainComponent::timerCallback()
{
    if (secondaryWindowClosing)
        return;

    if (startupWatchdogActive && frontendStartupState != FrontendStartupState::ready)
    {
        ++frontendStartupNavigationTicks;
        const auto elapsedMs = static_cast<int>(frontendStartupNavigationTicks * 100);
        if (elapsedMs >= kFrontendStartupTimeoutMs)
        {
            if (tryFallbackToPackagedFrontendAfterLocalTimeout())
                return;

            frontendStartupState = FrontendStartupState::timedOut;
            frontendStartupDetail = "No boot-ready signal was received from the embedded frontend within "
                                    + juce::String(kFrontendStartupTimeoutMs / 1000.0, 1)
                                    + " seconds.";
            startupWatchdogActive = false;

            auto detail = frontendStartupDetail
                        + "\n\nStartup state: " + describeFrontendStartupState(frontendStartupState)
                        + "\nStartup mode: " + getStartupModeQueryValue(startupMode)
                        + "\nTarget URL: " + frontendStartupTargetUrl
                        + "\nStartup log: " + getStartupLogFile().getFullPathName()
                        + "\n\nTry relaunching OpenStudio in safe mode.";

            juce::Logger::writeToLog("Frontend startup state: timed-out - " + detail);
            showStartupFallback("OpenStudio timed out while starting its interface.", detail, startupRepairAction != StartupRepairAction::none);
        }
    }

    if (isMainWindow())
    {
        const auto nowMs = juce::Time::getMillisecondCounterHiRes();
        constexpr double idleAiToolsPollIntervalMs = 2000.0;
        const bool shouldPollAiTools =
            lastAiToolsStatusPollMs <= 0.0
            || lastAiToolsInstallInProgress
            || nowMs - lastAiToolsStatusPollMs
                >= idleAiToolsPollIntervalMs;
        if (shouldPollAiTools)
        {
            const auto aiToolsStatus =
                audioEngine.getAiToolsStatus();
            lastAiToolsStatusPollMs = nowMs;
            bool installInProgress = false;
            juce::String digest;

            if (auto* obj = aiToolsStatus.getDynamicObject())
            {
                installInProgress =
                    static_cast<bool>(
                        obj->getProperty(
                            "installInProgress"));
                digest = obj->getProperty("state").toString()
                    + "|" + juce::String(static_cast<double>(obj->getProperty("progress")))
                    + "|" + obj->getProperty("message").toString()
                    + "|" + obj->getProperty("error").toString()
                    + "|" + obj->getProperty("errorCode").toString()
                    + "|" + obj->getProperty("statusWarning").toString()
                    + "|" + obj->getProperty("statusWarningCode").toString()
                    + "|" + obj->getProperty("installSessionId").toString()
                    + "|" + juce::String(static_cast<double>(obj->getProperty("elapsedMs")));
            }
            lastAiToolsInstallInProgress =
                installInProgress;

            if (digest != lastAiToolsStatusDigest
                || (installInProgress
                    && nowMs - lastAiToolsStatusEmitMs
                        >= 500.0))
            {
                emitFrontendEvent(
                    "aiToolsStatusUpdate",
                    aiToolsStatus);
                lastAiToolsStatusDigest = digest;
                lastAiToolsStatusEmitMs = nowMs;
            }
        }
    }

    // Broadcast transport position to frontend for playhead movement
    {
        double position = audioEngine.getTransportPosition();

        juce::DynamicObject::Ptr transportData = new juce::DynamicObject();
        transportData->setProperty("position", position);
        transportData->setProperty("isPlaying", audioEngine.isTransportPlaying());

        emitFrontendEvent("transportUpdate", juce::var(transportData.get()));
    }
    
    // Check for completed clips and emit events - REMOVED to allow explicit fetching via native function
    /*
    auto completedClips = audioEngine.getLastCompletedClips();
    for (const auto& clip : completedClips)
    {
        juce::DynamicObject::Ptr clipData = new juce::DynamicObject();
        clipData->setProperty("trackId", clip.trackId);
        clipData->setProperty("filePath", clip.file.getFullPathName());
        clipData->setProperty("startTime", clip.startTime);
        clipData->setProperty("duration", clip.duration);
        clipData->setProperty("name", clip.file.getFileNameWithoutExtension());
        
        webView.emitEventIfBrowserIsVisible("clipRecorded", juce::var(clipData.get()));
    }
    */
    
    // Detached plugin editors obtain their own small rack/tuner telemetry and
    // do not consume the DAW-wide meter event. Avoid rebuilding every track's
    // meter payload for those windows.
    if (windowRole != WindowRole::pluginEditor)
    {
        juce::var meterData(
            new juce::DynamicObject());
        auto* obj = meterData.getDynamicObject();

        obj->setProperty(
            "trackLevels",
            audioEngine.getMeterLevels());
        obj->setProperty(
            "midiInputLevels",
            audioEngine.getMIDIInputLevels());
        obj->setProperty(
            "trackClipping",
            audioEngine.getMeterClipStates());
        obj->setProperty(
            "masterLevel",
            audioEngine.getMasterLevel());
        obj->setProperty(
            "masterClipping",
            audioEngine.getMasterClipLatched());
        obj->setProperty(
            "timestamp",
            juce::Time::currentTimeMillis());
        emitFrontendEvent(
            "meterUpdate",
            meterData);
    }
}

//==============================================================================
void MainComponent::paint (juce::Graphics& g)
{
    // (Our component is opaque, so we must completely fill the background with a solid colour)
    g.fillAll (getLookAndFeel().findColour (juce::ResizableWindow::backgroundColourId));
}

void MainComponent::resized()
{
    auto bounds = getLocalBounds();
    webView.setBounds(bounds);
    startupStatusMessage.setBounds(bounds.reduced(40));
    if (startupFallbackVisible)
    {
        auto contentBounds = bounds.reduced(40);
        auto buttonArea = contentBounds.removeFromBottom(44);
        fallbackMessage.setBounds(contentBounds);

        auto buttons = juce::Array<juce::Component*>{
            &startupRetryButton,
            &startupOpenLogButton,
            &startupSafeModeButton,
            &startupRepairButton
        };

        int visibleButtons = 0;
        for (auto* button : buttons)
            if (button->isVisible())
                ++visibleButtons;

        if (visibleButtons == 0)
            return;

        constexpr int gap = 10;
        const int buttonWidth = juce::jmin(170, juce::jmax(120, (buttonArea.getWidth() - (gap * (visibleButtons - 1))) / visibleButtons));
        const int totalWidth = visibleButtons * buttonWidth + (visibleButtons - 1) * gap;
        auto row = juce::Rectangle<int>(buttonArea.getCentreX() - totalWidth / 2, buttonArea.getY(), totalWidth, buttonArea.getHeight());

        for (auto* button : buttons)
        {
            if (! button->isVisible())
                continue;

            button->setBounds(row.removeFromLeft(buttonWidth));
            row.removeFromLeft(gap);
        }
    }
    else
    {
        fallbackMessage.setBounds(bounds.reduced(40));
        hideStartupFallbackActions();
    }
}
