#include "PluginAutomationDelivery.h"
#include "CLAPPluginFormat.h"
#include "ProcessorSafety.h"
#include "PluginParameterCapture.h"
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <thread>

#ifdef _WIN32
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #include <windows.h>
  using LibHandle = HMODULE;
  static LibHandle loadLib(const juce::String& path, juce::String& errorMessage)
  {
      auto handle = LoadLibraryW(path.toWideCharPointer());
      if (handle == nullptr)
      {
          const auto errorCode = GetLastError();
          wchar_t systemMessage[512] {};
          const auto messageLength = FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                                                     nullptr,
                                                     errorCode,
                                                     0,
                                                     systemMessage,
                                                     static_cast<DWORD>(std::size(systemMessage)),
                                                     nullptr);
          errorMessage = messageLength > 0
              ? juce::String(systemMessage).trim()
              : "Windows error " + juce::String(static_cast<juce::int64>(errorCode));
      }
      return handle;
  }
  static void* getSymbol(LibHandle h, const char* name) { return (void*)GetProcAddress(h, name); }
  static void freeLib(LibHandle h) { FreeLibrary(h); }
#else
  #include <dlfcn.h>
  using LibHandle = void*;
  static LibHandle loadLib(const juce::String& path, juce::String& errorMessage)
  {
      dlerror();
      auto handle = dlopen(path.toRawUTF8(), RTLD_LOCAL | RTLD_LAZY);
      if (handle == nullptr)
      {
          if (const auto* error = dlerror())
              errorMessage = juce::String::fromUTF8(error);
      }
      return handle;
  }
  static void* getSymbol(LibHandle h, const char* name) { return dlsym(h, name); }
  static void freeLib(LibHandle h) { dlclose(h); }
#endif

static void logClapDiagnostic(const juce::String& message)
{
    juce::Logger::writeToLog("[CLAP] " + message);
}

static juce::String getMissingClapPluginCallbacks(const clap_plugin_t* plugin)
{
    if (plugin == nullptr)
        return "plugin";

    juce::StringArray missing;
    if (plugin->desc == nullptr)             missing.add("desc");
    if (plugin->init == nullptr)             missing.add("init");
    if (plugin->destroy == nullptr)          missing.add("destroy");
    if (plugin->activate == nullptr)         missing.add("activate");
    if (plugin->deactivate == nullptr)       missing.add("deactivate");
    if (plugin->start_processing == nullptr) missing.add("start_processing");
    if (plugin->stop_processing == nullptr)  missing.add("stop_processing");
    if (plugin->reset == nullptr)            missing.add("reset");
    if (plugin->process == nullptr)          missing.add("process");
    if (plugin->get_extension == nullptr)    missing.add("get_extension");
    if (plugin->on_main_thread == nullptr)   missing.add("on_main_thread");
    return missing.joinIntoString(", ");
}

static juce::String getMissingClapGuiCallbacks(const clap_plugin_gui_t* gui)
{
    if (gui == nullptr)
        return {};

    juce::StringArray missing;
    if (gui->is_api_supported == nullptr) missing.add("is_api_supported");
    if (gui->create == nullptr)           missing.add("create");
    if (gui->destroy == nullptr)          missing.add("destroy");
    if (gui->get_size == nullptr)         missing.add("get_size");
    if (gui->set_size == nullptr)         missing.add("set_size");
    if (gui->set_parent == nullptr)       missing.add("set_parent");
    if (gui->show == nullptr)             missing.add("show");
    return missing.joinIntoString(", ");
}

static void populateClapDescription(juce::PluginDescription& result,
                                    const clap_plugin_descriptor_t& clapDescriptor,
                                    const juce::File& moduleFile,
                                    bool hasSharedContainer)
{
    result.name = clapDescriptor.name ? clapDescriptor.name : "Unknown";
    result.manufacturerName = clapDescriptor.vendor ? clapDescriptor.vendor : "Unknown";
    result.descriptiveName = clapDescriptor.description ? clapDescriptor.description : "";
    result.version = clapDescriptor.version ? clapDescriptor.version : "";
    result.pluginFormatName = "CLAP";
    result.fileOrIdentifier = moduleFile.getFullPathName();
    result.uniqueId = juce::String(clapDescriptor.id ? clapDescriptor.id : "").hashCode();
    result.category = "";
    result.isInstrument = false;
    result.hasSharedContainer = hasSharedContainer;
    result.lastFileModTime = moduleFile.getLastModificationTime();
    result.lastInfoUpdateTime = juce::Time::getCurrentTime();

    if (clapDescriptor.features == nullptr)
        return;

    juce::StringArray features;
    for (int i = 0; clapDescriptor.features[i] != nullptr; ++i)
        features.add(clapDescriptor.features[i]);

    result.isInstrument = features.contains(CLAP_PLUGIN_FEATURE_INSTRUMENT);

    if (result.isInstrument)
        result.category = "Instrument";
    else if (features.contains(CLAP_PLUGIN_FEATURE_AUDIO_EFFECT))
        result.category = "Effect";
    else if (features.contains(CLAP_PLUGIN_FEATURE_ANALYZER))
        result.category = "Analyzer";
}

static bool updateClapChannelMetadata(const clap_plugin_t& plugin,
                                      juce::PluginDescription& description)
{
    const auto* audioPorts = static_cast<const clap_plugin_audio_ports_t*>(
        plugin.get_extension(&plugin, CLAP_EXT_AUDIO_PORTS));

    if (audioPorts == nullptr || audioPorts->count == nullptr || audioPorts->get == nullptr)
        return false;

    const auto countChannels = [&plugin, audioPorts](bool isInput)
    {
        uint64_t totalChannels = 0;
        const auto numPorts = audioPorts->count(&plugin, isInput);

        for (uint32_t i = 0; i < numPorts; ++i)
        {
            clap_audio_port_info_t portInfo {};
            if (audioPorts->get(&plugin, i, isInput, &portInfo))
                totalChannels += portInfo.channel_count;
        }

        return static_cast<int>(juce::jmin(
            totalChannels,
            static_cast<uint64_t>((std::numeric_limits<int>::max)())));
    };

    description.numInputChannels = countChannels(true);
    description.numOutputChannels = countChannels(false);
    return true;
}

//==============================================================================
// Minimal CLAP host implementation required by the CLAP API
//==============================================================================

class CLAPHostContext final : private juce::Timer
{
public:
    clap_host_t host {};
    const clap_plugin_t* plugin = nullptr; // Main-thread lifecycle only.
    std::atomic<bool> flushRequested { false }, callbackRequested { false }, restartRequested { false };
    std::atomic<uint32_t> rescanFlags { 0 };
    // CLAP declares clear() main-thread-only. Coalesce requests until the
    // callback try-lock succeeds; clearing references does not restart DSP.
    std::map<clap_id, uint32_t> pendingClears;
    std::function<void(uint32_t, bool)> poll;

    CLAPHostContext()
    {
        host.clap_version = CLAP_VERSION;
        host.host_data = this;
        host.name = "OpenStudio";
        host.vendor = "OpenStudio";
        host.url = "";
        host.version = "1.0.0";
        host.request_restart = [](const clap_host_t* h) { context(h).restartRequested.store(true); };
        host.request_process = [](const clap_host_t* h) { context(h).flushRequested.store(true); };
        host.request_callback = [](const clap_host_t* h) { context(h).callbackRequested.store(true); };
        host.get_extension = [](const clap_host_t*, const char* id) -> const void*
        {
            static const clap_host_params_t parameters {
                [](const clap_host_t* h, clap_param_rescan_flags flags) { context(h).rescanFlags.fetch_or(flags); },
                [](const clap_host_t* h, clap_id id, clap_param_clear_flags flags) {
                    if (flags & (CLAP_PARAM_CLEAR_ALL | CLAP_PARAM_CLEAR_AUTOMATIONS))
                        context(h).pendingClears[id] |= flags;
                },
                [](const clap_host_t* h) { context(h).flushRequested.store(true); }
            };
            return id && std::strcmp(id, CLAP_EXT_PARAMS) == 0 ? &parameters : nullptr;
        };
        startTimer(30);
    }
    ~CLAPHostContext() override { stop(); }
    void stop() { stopTimer(); plugin = nullptr; poll = {}; }
private:
    static CLAPHostContext& context(const clap_host_t* h) { return *static_cast<CLAPHostContext*>(h->host_data); }
    void timerCallback() override
    {
        if (plugin && callbackRequested.exchange(false)) plugin->on_main_thread(plugin);
        if (poll) poll(rescanFlags.exchange(0), restartRequested.exchange(false));
    }
};

//==============================================================================
// CLAP Plugin Instance — wraps a clap_plugin_t as a juce::AudioProcessor
//==============================================================================

// Forward declaration for editor
class CLAPPluginInstance;

//==============================================================================
// CLAP GUI Editor — wraps the CLAP GUI extension in a JUCE AudioProcessorEditor
//==============================================================================

class CLAPEditorComponent : public juce::AudioProcessorEditor
{
public:
    CLAPEditorComponent(juce::AudioProcessor& proc, const clap_plugin_t* plugin,
                         const clap_plugin_gui_t* gui)
        : AudioProcessorEditor(proc), clapPlugin(plugin), guiExt(gui)
    {
        setOpaque(true);
        setSize(800, 600); // Default; will be adjusted after create

        // Try to create GUI
        if (guiExt && clapPlugin)
        {
#ifdef _WIN32
            const char* apiStr = CLAP_WINDOW_API_WIN32;
#elif __APPLE__
            const char* apiStr = CLAP_WINDOW_API_COCOA;
#else
            const char* apiStr = CLAP_WINDOW_API_X11;
#endif
            if (guiExt->is_api_supported(clapPlugin, apiStr, false))
                guiCreated = guiExt->create(clapPlugin, apiStr, false);
        }
    }

    ~CLAPEditorComponent() override
    {
        if (guiCreated && guiExt && clapPlugin)
        {
            guiExt->set_parent(clapPlugin, nullptr);
            guiExt->destroy(clapPlugin);
        }
    }

    void parentHierarchyChanged() override
    {
        if (!guiCreated || !guiExt || !clapPlugin || parentSet)
            return;

        auto* peer = getPeer();
        if (!peer)
            return;

        void* nativeHandle = peer->getNativeHandle();
        if (!nativeHandle)
            return;

        clap_window_t window{};
#ifdef _WIN32
        window.api = CLAP_WINDOW_API_WIN32;
        window.win32 = nativeHandle;
#elif __APPLE__
        window.api = CLAP_WINDOW_API_COCOA;
        window.cocoa = nativeHandle;
#else
        window.api = CLAP_WINDOW_API_X11;
        window.x11 = (unsigned long)(uintptr_t)nativeHandle;
#endif
        if (!guiExt->set_parent(clapPlugin, &window))
            return;

        // Query preferred size
        uint32_t w = 0, h = 0;
        if (guiExt->get_size(clapPlugin, &w, &h) && w > 0 && h > 0)
            setSize(static_cast<int>(w), static_cast<int>(h));

        if (!guiExt->show(clapPlugin))
            logClapDiagnostic("Plugin GUI could not be shown: " + getAudioProcessor()->getName());
        parentSet = true;
    }

    void resized() override
    {
        if (guiCreated && guiExt && clapPlugin)
        {
            uint32_t w = static_cast<uint32_t>(getWidth());
            uint32_t h = static_cast<uint32_t>(getHeight());
            guiExt->set_size(clapPlugin, w, h);
        }
    }

    void paint(juce::Graphics& g) override
    {
        g.fillAll(juce::Colours::black);
    }

private:
    const clap_plugin_t* clapPlugin = nullptr;
    const clap_plugin_gui_t* guiExt = nullptr;
    bool guiCreated = false;
    bool parentSet = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(CLAPEditorComponent)
};

//==============================================================================
// CLAP Parameter — wraps a single CLAP parameter as a juce::AudioProcessorParameter
//==============================================================================

struct CLAPAutomationInputQueue
{
    static constexpr size_t capacity = 8192;
    std::array<clap_event_param_value_t, capacity> events {};
    size_t size = 0;
};

class CLAPParameter : public juce::AudioPluginInstance::HostedParameter
{
public:
    CLAPParameter(const clap_plugin_t* plugin, const clap_plugin_params_t* paramsExt,
                   clap_id paramId, const juce::String& paramName,
                   double minVal, double maxVal, double defaultVal, uint32_t flagsIn, void* cookieIn, CLAPAutomationInputQueue* automationIn = nullptr)
        : clapPlugin(plugin), paramsExtension(paramsExt)
        , id(paramId), parameterName(paramName)
        , rangeMin(minVal), rangeMax(maxVal), defaultValue(defaultVal), flags(flagsIn), cookie(cookieIn), automation(automationIn)
    {
        double initial = defaultVal;
        if (paramsExtension->get_value) paramsExtension->get_value(clapPlugin, id, &initial);
        currentValue.store(juce::jlimit(rangeMin, rangeMax, initial));
    }

    float getValue() const override
    {
        if (rangeMax <= rangeMin) return 0.0f;
        return static_cast<float>((currentValue.load(std::memory_order_acquire) - rangeMin) / (rangeMax - rangeMin));
    }

    void setValue(float newValue) override
    {
        if (!available || !std::isfinite(newValue) || (flags & CLAP_PARAM_IS_READONLY)) return;
        auto native = rangeMin + static_cast<double>(juce::jlimit(0.0f, 1.0f, newValue)) * (rangeMax - rangeMin);
        if (isDiscrete()) native = std::round(native);
        native = juce::jlimit(rangeMin, rangeMax, native);
        currentValue.store(native, std::memory_order_release);
        pendingValue.store(native, std::memory_order_relaxed);
        pending.store(true, std::memory_order_release);
    }

    bool supportsSampleAccurateAutomation() const noexcept override { return automation != nullptr; }
    bool queueValueAtSampleOffset(float value, int offset) noexcept override
    {
        if (!automation || !isAutomatable() || offset < 0 || !std::isfinite(value) || automation->size >= automation->events.size()) return false;
        auto native = rangeMin + static_cast<double>(juce::jlimit(0.0f, 1.0f, value)) * (rangeMax - rangeMin);
        if (isDiscrete()) native = std::round(native);
        currentValue.store(native, std::memory_order_release);
        auto& event = automation->events[automation->size++]; event = {};
        event.header.size = sizeof(event); event.header.time = static_cast<uint32_t>(offset);
        event.header.type = CLAP_EVENT_PARAM_VALUE; event.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
        event.param_id = id; event.cookie = cookie; event.value = native;
        event.note_id = -1; event.port_index = -1; event.channel = -1; event.key = -1;
        automationQueued = true;
        return true;
    }
    void finishAutomationBlock() noexcept { automationQueued = false; }

    float getDefaultValue() const override
    {
        if (rangeMax <= rangeMin) return 0.0f;
        return static_cast<float>((defaultValue - rangeMin) / (rangeMax - rangeMin));
    }

    juce::String getName(int maximumStringLength) const override
    {
        return parameterName.substring(0, maximumStringLength);
    }

    juce::String getLabel() const override { return {}; }
    bool isAutomatable() const override { return available && rangeMax > rangeMin && (flags & CLAP_PARAM_IS_AUTOMATABLE) && !(flags & CLAP_PARAM_IS_READONLY); }
    bool isDiscrete() const override { return (flags & CLAP_PARAM_IS_STEPPED) != 0; }
    bool isBoolean() const override { return isDiscrete() && rangeMin == 0 && rangeMax == 1; }
    int getNumSteps() const override
    {
        return isDiscrete() ? static_cast<int>(juce::jlimit(2.0, static_cast<double>(std::numeric_limits<int>::max()),
            std::round(rangeMax - rangeMin) + 1.0)) : getDefaultNumParameterSteps();
    }
    juce::String getText(float value, int length) const override
    {
        double native = rangeMin + juce::jlimit(0.0f, 1.0f, value) * (rangeMax - rangeMin);
        if (isDiscrete()) native = std::round(native);
        char text[256] {};
        if (paramsExtension->value_to_text && paramsExtension->value_to_text(clapPlugin, id, native, text, sizeof(text)))
            return juce::String::fromUTF8(text, static_cast<int>(sizeof(text))).substring(0, length);
        return juce::String(native, 3).substring(0, length);
    }

    juce::String getParameterID() const override
    {
        return juce::String(static_cast<int64_t>(id));
    }

    float getValueForText(const juce::String& text) const override
    {
        double val = text.getDoubleValue();
        if (paramsExtension->text_to_value) paramsExtension->text_to_value(clapPlugin, id, text.toRawUTF8(), &val);
        if (rangeMax <= rangeMin) return 0.0f;
        return juce::jlimit(0.0f, 1.0f, static_cast<float>((val - rangeMin) / (rangeMax - rangeMin)));
    }

    clap_id getClapId() const { return id; }
    double getNativeMinimum() const { return rangeMin; }
    double getNativeMaximum() const { return rangeMax; }
    uint64_t getReferenceGeneration() const { return referenceGeneration.load(std::memory_order_acquire); }
    void clearReferences()
    {
        pending.store(false, std::memory_order_release);
        automationQueued = false;
        publishGesture(false);
        referenceGeneration.fetch_add(1, std::memory_order_release);
    }
    void updateInfo(const clap_param_info_t& info)
    {
        parameterName = juce::String(info.name);
        rangeMin = info.min_value; rangeMax = info.max_value; defaultValue = info.default_value;
        flags = info.flags; cookie = info.cookie; available = true;
        double value = defaultValue;
        if (paramsExtension->get_value) paramsExtension->get_value(clapPlugin, id, &value);
        restoreNativeValue(value);
    }
    void retire()
    {
        publishGesture(false);
        available = false;
        pending.store(false, std::memory_order_release);
    }
    bool takePendingValue(clap_event_param_value_t& event)
    {
        if (!pending.exchange(false, std::memory_order_acq_rel) || !available || automationQueued) return false;
        event = {};
        event.header.size = sizeof(event);
        event.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
        event.header.type = CLAP_EVENT_PARAM_VALUE;
        event.param_id = id;
        event.cookie = cookie;
        event.note_id = -1; event.port_index = -1; event.channel = -1; event.key = -1;
        event.value = pendingValue.load(std::memory_order_acquire);
        return true;
    }
    void publishNativeValue(double value, bool record)
    {
        if (!std::isfinite(value)) return;
        currentValue.store(juce::jlimit(rangeMin, rangeMax, value), std::memory_order_release);
        if (record && isAutomatable()) sendValueChangedMessageToListeners(getValue());
    }
    void restoreNativeValue(double value)
    {
        pending.store(false, std::memory_order_release);
        publishNativeValue(value, false);
    }
    void publishGesture(bool begin)
    {
        if (!isAutomatable()) return;
        if (begin && !gesture.exchange(true)) beginChangeGesture();
        else if (!begin && gesture.exchange(false)) endChangeGesture();
    }

private:
    const clap_plugin_t* clapPlugin;
    const clap_plugin_params_t* paramsExtension;
    clap_id id;
    juce::String parameterName;
    double rangeMin, rangeMax, defaultValue;
    uint32_t flags = 0;
    bool available = true; // Changed only while the processor callback lock is held.
    void* cookie = nullptr;
    std::atomic<double> currentValue { 0 }, pendingValue { 0 };
    std::atomic<bool> pending { false }, gesture { false };
    std::atomic<uint64_t> referenceGeneration { 0 };
    CLAPAutomationInputQueue* automation = nullptr;
    bool automationQueued = false;
};

//==============================================================================
// CLAP Plugin Instance — wraps a clap_plugin_t as a juce::AudioProcessor
//==============================================================================

class CLAPPluginInstance : public juce::AudioPluginInstance
{
public:
    CLAPPluginInstance(LibHandle lib, const clap_plugin_t* plugin,
                       juce::PluginDescription description, std::unique_ptr<CLAPHostContext> context)
        : juce::AudioPluginInstance(BusesProperties()
              .withInput("Input", juce::AudioChannelSet::stereo(), true)
              .withOutput("Output", juce::AudioChannelSet::stereo(), true))
        , libHandle(lib)
        , clapPlugin(plugin)
        , pluginDescription(std::move(description))
        , hostContext(std::move(context))
    {
        if (clapPlugin)
        {
            // Discover parameters
            const auto* candidateParams = static_cast<const clap_plugin_params_t*>(
                clapPlugin->get_extension(clapPlugin, CLAP_EXT_PARAMS));
            if (candidateParams != nullptr && candidateParams->count != nullptr
                                           && candidateParams->get_info != nullptr)
            {
                paramsExt = candidateParams;
                uint32_t paramCount = juce::jmin(uint32_t(65536), paramsExt->count(clapPlugin));
                for (uint32_t i = 0; i < paramCount; ++i)
                {
                    clap_param_info_t info{};
                    if (paramsExt->get_info(clapPlugin, i, &info))
                    {
                        if (!std::isfinite(info.min_value) || !std::isfinite(info.max_value)
                            || !std::isfinite(info.default_value) || info.max_value < info.min_value)
                            continue;
                        auto param = std::make_unique<CLAPParameter>(clapPlugin, paramsExt,
                                                                      info.id, juce::String(info.name),
                                                                      info.min_value, info.max_value,
                                                                      info.default_value, info.flags, info.cookie, &automationInput);
                        clapParams.add(param.get());
                        parametersById.emplace(info.id, param.get());
                        addHostedParameter(std::move(param));
                    }
                }
            }

            inContext.midiEvents.reserve(maxMidiEvents);
            inContext.parameterEvents.reserve(static_cast<size_t>(clapParams.size()) + CLAPAutomationInputQueue::capacity);
            inContext.headers.reserve(maxMidiEvents + static_cast<size_t>(clapParams.size()) + CLAPAutomationInputQueue::capacity);

            // Check for GUI support
            const auto* candidateGui = static_cast<const clap_plugin_gui_t*>(
                clapPlugin->get_extension(clapPlugin, CLAP_EXT_GUI));
            const auto missingGuiCallbacks = getMissingClapGuiCallbacks(candidateGui);
            if (candidateGui != nullptr && missingGuiCallbacks.isEmpty())
            {
                guiExt = candidateGui;
            }
            else if (candidateGui != nullptr)
            {
                logClapDiagnostic("Ignoring incomplete GUI extension for '"
                                  + pluginDescription.name + "'; missing: "
                                  + missingGuiCallbacks);
            }
        }
        hostContext->poll = [this](uint32_t flags, bool restart)
        {
            const juce::ScopedTryLock guard(getCallbackLock());
            if (!guard.isLocked())
            {
                hostContext->rescanFlags.fetch_or(flags);
                if (restart) hostContext->restartRequested.store(true);
                return;
            }
            if (!hostContext->pendingClears.empty())
            {
                for (const auto& [id, clearFlags] : hostContext->pendingClears)
                    if (const auto found = parametersById.find(id); found != parametersById.end())
                    {
                        found->second->clearReferences();
                        size_t remaining = 0;
                        for (size_t i = 0; i < automationInput.size; ++i)
                            if (automationInput.events[i].param_id != id)
                                automationInput.events[remaining++] = automationInput.events[i];
                        automationInput.size = remaining;
                        auto* cleared = new juce::DynamicObject();
                        cleared->setProperty("index", found->second->getParameterIndex());
                        cleared->setProperty("flags", static_cast<juce::int64>(clearFlags));
                        parameterClears.add(juce::var(cleared));
                    }
                hostContext->pendingClears.clear();
                updateHostDisplay(juce::AudioProcessorListener::ChangeDetails().withParameterInfoChanged(true));
            }
            if (restart || (flags & CLAP_PARAM_RESCAN_ALL))
            {
                const bool resume = activated;
                const auto sampleRate = currentSampleRate;
                const auto blockSize = currentBlockSize;
                releaseResources();
                if (flags & CLAP_PARAM_RESCAN_ALL) rescanParameters(true);
                if (resume) prepareToPlay(sampleRate, blockSize);
            }
            else if (flags & CLAP_PARAM_RESCAN_INFO) rescanParameters(false);
            if (flags & CLAP_PARAM_RESCAN_TEXT)
                updateHostDisplay(juce::AudioProcessorListener::ChangeDetails().withParameterInfoChanged(true));
            if ((flags & CLAP_PARAM_RESCAN_VALUES) && paramsExt && paramsExt->get_value)
                for (auto* parameter : clapParams)
                {
                    double value = 0;
                    if (paramsExt->get_value(clapPlugin, parameter->getClapId(), &value))
                        parameter->publishNativeValue(value, false);
                }
            if (!activated) flushParameterRequests();
        };
    }

    ~CLAPPluginInstance() override
    {
        hostContext->stop();
        // CLAP spec requires deactivate before destroy. If releaseResources()
        // wasn't called (e.g., unexpected destruction path), do it now.
        if (clapPlugin && activated)
            releaseResources();
        for (auto* parameter : clapParams) parameter->publishGesture(false);

        if (clapPlugin)
        {
            clapPlugin->destroy(clapPlugin);
            clapPlugin = nullptr;
        }
        if (libHandle)
        {
            // Find entry and deinit
            auto* entryFn = (const clap_plugin_entry_t*)getSymbol(libHandle, "clap_entry");
            if (entryFn != nullptr && entryFn->deinit != nullptr)
                entryFn->deinit();
            freeLib(libHandle);
            libHandle = nullptr;
        }
    }

    // --- AudioPluginInstance overrides ---

    void fillInPluginDescription(juce::PluginDescription& desc) const override
    {
        desc = pluginDescription;
    }

    const juce::String getName() const override { return pluginDescription.name; }

    void prepareToPlay(double sampleRate, int samplesPerBlock) override
    {
        if (!clapPlugin) return;
        if (activated) releaseResources();

        if (!clapPlugin->activate(clapPlugin,
                                  sampleRate,
                                  static_cast<uint32_t>(samplesPerBlock),
                                  static_cast<uint32_t>(samplesPerBlock)))
        {
            logClapDiagnostic("Activation failed for: " + pluginDescription.name);
            return;
        }

        if (!clapPlugin->start_processing(clapPlugin))
        {
            clapPlugin->deactivate(clapPlugin);
            logClapDiagnostic("Processing startup failed for: " + pluginDescription.name);
            return;
        }

        currentSampleRate = sampleRate;
        currentBlockSize = samplesPerBlock;
        activated = true;
    }

    void releaseResources() override
    {
        if (!clapPlugin || !activated) return;
        clapPlugin->stop_processing(clapPlugin);
        clapPlugin->deactivate(clapPlugin);
        activated = false;
        for (auto* parameter : clapParams) parameter->publishGesture(false);
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages) override
    {
        if (!clapPlugin || !activated)
            return;
        flushParameterRequests();

        const int numSamples = buffer.getNumSamples();
        const int numCh = buffer.getNumChannels();
        if (numSamples == 0 || numCh == 0) return;

        // Build CLAP audio buffers
        float* channelPtrs[2] = { nullptr, nullptr };
        for (int ch = 0; ch < juce::jmin(numCh, 2); ++ch)
            channelPtrs[ch] = buffer.getWritePointer(ch);
        // If mono input, duplicate to second channel pointer
        if (numCh == 1)
            channelPtrs[1] = channelPtrs[0];

        clap_audio_buffer_t inputBuf{};
        inputBuf.data32 = channelPtrs;
        inputBuf.data64 = nullptr;
        inputBuf.channel_count = 2;
        inputBuf.latency = 0;
        inputBuf.constant_mask = 0;

        clap_audio_buffer_t outputBuf{};
        outputBuf.data32 = channelPtrs; // In-place processing
        outputBuf.data64 = nullptr;
        outputBuf.channel_count = 2;
        outputBuf.latency = 0;
        outputBuf.constant_mask = 0;

        clap_process_t process{};
        process.steady_time = -1;
        process.frames_count = (uint32_t)numSamples;
        process.audio_inputs = &inputBuf;
        process.audio_outputs = &outputBuf;
        process.audio_inputs_count = 1;
        process.audio_outputs_count = 1;
        process.in_events = nullptr;
        process.out_events = nullptr;

        clap_event_transport_t transport {};
        transport.header.size = sizeof(clap_event_transport_t);
        transport.header.time = 0;
        transport.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
        transport.header.type = CLAP_EVENT_TRANSPORT;
        transport.header.flags = 0;

        uint32_t transportFlags = CLAP_TRANSPORT_HAS_SECONDS_TIMELINE
                                | CLAP_TRANSPORT_HAS_BEATS_TIMELINE
                                | CLAP_TRANSPORT_HAS_TEMPO
                                | CLAP_TRANSPORT_HAS_TIME_SIGNATURE;

        if (auto* currentPlayHead = getPlayHead())
        {
            auto position = currentPlayHead->getPosition();
            if (position.hasValue())
            {
                auto info = *position;
                const double seconds = info.getTimeInSeconds().orFallback(0.0);
                const double bpm = info.getBpm().orFallback(120.0);
                const auto timeSig = info.getTimeSignature().orFallback(juce::AudioPlayHead::TimeSignature { 4, 4 });
                const double ppq = info.getPpqPosition().orFallback(seconds * (bpm / 60.0));
                const double barStart = info.getPpqPositionOfLastBarStart().orFallback(0.0);

                if (info.getIsPlaying())
                    transportFlags |= CLAP_TRANSPORT_IS_PLAYING;
                if (info.getIsRecording())
                    transportFlags |= CLAP_TRANSPORT_IS_RECORDING;
                if (info.getIsLooping())
                    transportFlags |= CLAP_TRANSPORT_IS_LOOP_ACTIVE;

                transport.flags = transportFlags;
                transport.song_pos_seconds = static_cast<clap_sectime>(std::llround(seconds * CLAP_SECTIME_FACTOR));
                transport.song_pos_beats = static_cast<clap_beattime>(std::llround(ppq * CLAP_BEATTIME_FACTOR));
                transport.tempo = bpm;
                transport.tempo_inc = 0.0;
                transport.bar_start = static_cast<clap_beattime>(std::llround(barStart * CLAP_BEATTIME_FACTOR));
                transport.bar_number = (timeSig.numerator > 0 && timeSig.denominator > 0)
                    ? static_cast<int32_t>(std::floor(barStart / (timeSig.numerator * (4.0 / timeSig.denominator))))
                    : 0;
                transport.tsig_num = static_cast<uint16_t>(juce::jlimit(1, 64, timeSig.numerator));
                transport.tsig_denom = static_cast<uint16_t>(juce::jlimit(1, 64, timeSig.denominator));
            }
            else
            {
                transport.flags = transportFlags;
            }
        }
        else
        {
            transport.flags = transportFlags;
        }

        process.transport = &transport;

        inContext.midiEvents.clear();
        inContext.parameterEvents.clear();
        inContext.headers.clear();
        for (auto* parameter : clapParams)
        {
            clap_event_param_value_t event {};
            if (parameter->takePendingValue(event))
            {
                inContext.parameterEvents.push_back(event);
                inContext.headers.push_back({ &inContext.parameterEvents.back().header, inContext.headers.size() });
            }
        }

        for (size_t index = 0; index < automationInput.size; ++index)
        {
            auto event = automationInput.events[index];
            event.header.time = static_cast<uint32_t>(juce::jlimit(0, juce::jmax(0, numSamples - 1), static_cast<int>(event.header.time)));
            inContext.parameterEvents.push_back(event);
            inContext.headers.push_back({ &inContext.parameterEvents.back().header, inContext.headers.size() });
        }
        automationInput.size = 0;
        for (auto* parameter : clapParams) parameter->finishAutomationBlock();

        for (const auto metadata : midiMessages)
        {
            if (inContext.midiEvents.size() >= maxMidiEvents)
            {
                droppedMidiEvents.fetch_add(1, std::memory_order_relaxed);
                continue;
            }
            const auto& message = metadata.getMessage();
            if (message.isSysEx())
                continue;

            const int rawSize = message.getRawDataSize();
            if (rawSize <= 0 || rawSize > 3)
                continue;

            clap_event_midi_t event {};
            event.header.size = sizeof(clap_event_midi_t);
            event.header.time = static_cast<uint32_t>(juce::jlimit(0, juce::jmax(0, numSamples - 1), metadata.samplePosition));
            event.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
            event.header.type = CLAP_EVENT_MIDI;
            event.header.flags = 0;
            event.port_index = 0;
            std::memset(event.data, 0, sizeof(event.data));
            std::memcpy(event.data, message.getRawData(), static_cast<size_t>(rawSize));

            inContext.midiEvents.push_back(event);
            inContext.headers.push_back({ &inContext.midiEvents.back().header, inContext.headers.size() });
        }

        clap_input_events_t inEvents{};
        std::sort(inContext.headers.begin(), inContext.headers.end(), [](const auto& a, const auto& b) {
            return a.header->time != b.header->time ? a.header->time < b.header->time : a.order < b.order;
        });
        inEvents.ctx = &inContext;
        inEvents.size = [](const clap_input_events_t* events) -> uint32_t {
            auto* ctx = static_cast<InputEventsContext*>(events->ctx);
            return static_cast<uint32_t>(ctx->headers.size());
        };
        inEvents.get = [](const clap_input_events_t* events, uint32_t index) -> const clap_event_header_t* {
            auto* ctx = static_cast<InputEventsContext*>(events->ctx);
            if (index >= ctx->headers.size())
                return nullptr;
            return ctx->headers[index].header;
        };
        process.in_events = &inEvents;

        struct OutputEventsContext
        {
            juce::MidiBuffer* midiBuffer = nullptr;
            int maxSamples = 0;
            CLAPPluginInstance* owner = nullptr;
        };

        OutputEventsContext outContext { &midiMessages, numSamples, this };
        clap_output_events_t outEvents{};
        outEvents.ctx = &outContext;
        outEvents.try_push = [](const clap_output_events_t* events, const clap_event_header_t* header) -> bool {
            if (events == nullptr || header == nullptr || header->space_id != CLAP_CORE_EVENT_SPACE_ID
                || header->size < sizeof(clap_event_header_t))
                return false;

            auto* ctx = static_cast<OutputEventsContext*>(events->ctx);
            if (ctx == nullptr || ctx->midiBuffer == nullptr)
                return false;

            const int sampleOffset = juce::jlimit(0, juce::jmax(0, ctx->maxSamples - 1), static_cast<int>(header->time));

            switch (header->type)
            {
                case CLAP_EVENT_PARAM_VALUE:
                case CLAP_EVENT_PARAM_GESTURE_BEGIN:
                case CLAP_EVENT_PARAM_GESTURE_END:
                {
                    const ScopedPluginAutomationSampleOffset captureOffset(sampleOffset);
                    return ctx->owner->publishParameterEvent(header);
                }
                case CLAP_EVENT_MIDI:
                {
                    if (header->size < sizeof(clap_event_midi_t)) return false;
                    auto* midi = reinterpret_cast<const clap_event_midi_t*>(header);
                    ctx->midiBuffer->addEvent(juce::MidiMessage(midi->data, 3), sampleOffset);
                    return true;
                }
                case CLAP_EVENT_NOTE_ON:
                {
                    if (header->size < sizeof(clap_event_note_t)) return false;
                    auto* note = reinterpret_cast<const clap_event_note_t*>(header);
                    ctx->midiBuffer->addEvent(
                        juce::MidiMessage::noteOn(
                            juce::jlimit(1, 16, static_cast<int>(note->channel) + 1),
                            juce::jlimit(0, 127, static_cast<int>(note->key)),
                            static_cast<juce::uint8>(juce::jlimit(0, 127, static_cast<int>(std::round(note->velocity * 127.0))))),
                        sampleOffset);
                    return true;
                }
                case CLAP_EVENT_NOTE_OFF:
                case CLAP_EVENT_NOTE_CHOKE:
                {
                    if (header->size < sizeof(clap_event_note_t)) return false;
                    auto* note = reinterpret_cast<const clap_event_note_t*>(header);
                    ctx->midiBuffer->addEvent(
                        juce::MidiMessage::noteOff(
                            juce::jlimit(1, 16, static_cast<int>(note->channel) + 1),
                            juce::jlimit(0, 127, static_cast<int>(note->key))
                        ),
                        sampleOffset);
                    return true;
                }
                default:
                    return true;
            }
        };
        process.out_events = &outEvents;

        clapPlugin->process(clapPlugin, &process);
    }

    double getTailLengthSeconds() const override { return 0.0; }

    void rescanParameters(bool topology)
    {
        if (!paramsExt || !paramsExt->count || !paramsExt->get_info) return;
        if (topology) for (auto* parameter : clapParams) parameter->retire();
        const auto count = juce::jmin(uint32_t(65536), paramsExt->count(clapPlugin));
        for (uint32_t index = 0; index < count; ++index)
        {
            clap_param_info_t info {};
            if (!paramsExt->get_info(clapPlugin, index, &info) || info.id == CLAP_INVALID_ID
                || !std::isfinite(info.min_value) || !std::isfinite(info.max_value)
                || !std::isfinite(info.default_value) || info.max_value < info.min_value) continue;
            if (const auto found = parametersById.find(info.id); found != parametersById.end()) found->second->updateInfo(info);
            else if (topology && clapParams.size() < 65536)
            {
                // Keep existing JUCE indices and parameter objects alive. A removed ID
                // becomes inert; new IDs append rather than retargeting old envelopes.
                auto parameter = std::make_unique<CLAPParameter>(clapPlugin, paramsExt, info.id, juce::String(info.name),
                    info.min_value, info.max_value, info.default_value, info.flags, info.cookie, &automationInput);
                clapParams.add(parameter.get()); parametersById.emplace(info.id, parameter.get());
                addHostedParameter(std::move(parameter));
            }
        }
        if (topology)
        {
            inContext.parameterEvents.reserve(static_cast<size_t>(clapParams.size()) + CLAPAutomationInputQueue::capacity);
            inContext.headers.reserve(maxMidiEvents + static_cast<size_t>(clapParams.size()) + CLAPAutomationInputQueue::capacity);
        }
        updateHostDisplay(juce::AudioProcessorListener::ChangeDetails().withParameterInfoChanged(true));
    }

    void flushParameterRequests()
    {
        if (!paramsExt || !paramsExt->flush || !hostContext->flushRequested.exchange(false)) return;
        const clap_input_events_t input { nullptr,
            [](const clap_input_events_t*) -> uint32_t { return 0; },
            [](const clap_input_events_t*, uint32_t) -> const clap_event_header_t* { return nullptr; } };
        const clap_output_events_t output { this,
            [](const clap_output_events_t* events, const clap_event_header_t* event) -> bool
            {
                if (!event || event->space_id != CLAP_CORE_EVENT_SPACE_ID || event->size < sizeof(clap_event_header_t)) return false;
                if (event->type != CLAP_EVENT_PARAM_VALUE && event->type != CLAP_EVENT_PARAM_GESTURE_BEGIN && event->type != CLAP_EVENT_PARAM_GESTURE_END) return false;
                return static_cast<CLAPPluginInstance*>(events->ctx)->publishParameterEvent(event);
            } };
        paramsExt->flush(clapPlugin, &input, &output);
    }

    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }

    juce::AudioProcessorEditor* createEditor() override
    {
        if (guiExt && clapPlugin)
            return new CLAPEditorComponent(*this, clapPlugin, guiExt);
        return nullptr;
    }
    bool hasEditor() const override { return guiExt != nullptr; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override
    {
        if (!clapPlugin) return;
        auto* stateExt = (const clap_plugin_state_t*)clapPlugin->get_extension(clapPlugin, CLAP_EXT_STATE);
        if (!stateExt) return;

        // Use a stream to capture state
        struct StreamCtx { juce::MemoryBlock* block; };
        StreamCtx ctx{ &destData };

        clap_ostream_t stream{};
        stream.ctx = &ctx;
        stream.write = [](const clap_ostream_t* s, const void* buffer, uint64_t size) -> int64_t {
            auto* c = (StreamCtx*)s->ctx;
            c->block->append(buffer, (size_t)size);
            return (int64_t)size;
        };
        stateExt->save(clapPlugin, &stream);
    }

    void setStateInformation(const void* data, int sizeInBytes) override
    {
        if (!clapPlugin) return;
        auto* stateExt = (const clap_plugin_state_t*)clapPlugin->get_extension(clapPlugin, CLAP_EXT_STATE);
        if (!stateExt) return;

        struct StreamCtx { const void* data; int size; int pos; };
        StreamCtx ctx{ data, sizeInBytes, 0 };

        clap_istream_t stream{};
        stream.ctx = &ctx;
        stream.read = [](const clap_istream_t* s, void* buffer, uint64_t size) -> int64_t {
            auto* c = (StreamCtx*)s->ctx;
            auto toRead = juce::jmin((int)size, c->size - c->pos);
            if (toRead <= 0) return 0;
            std::memcpy(buffer, (const char*)c->data + c->pos, (size_t)toRead);
            c->pos += toRead;
            return (int64_t)toRead;
        };
        if (stateExt->load(clapPlugin, &stream) && paramsExt && paramsExt->get_value)
            for (auto* parameter : clapParams)
            {
                double value = 0;
                if (paramsExt->get_value(clapPlugin, parameter->getClapId(), &value))
                    parameter->restoreNativeValue(value);
            }
    }

    juce::Array<juce::var> takeParameterClears()
    {
        const juce::ScopedLock guard(getCallbackLock());
        juce::Array<juce::var> result; result.swapWith(parameterClears); return result;
    }
private:
    bool publishParameterEvent(const clap_event_header_t* header)
    {
        if (header->type == CLAP_EVENT_PARAM_VALUE)
        {
            if (header->size < sizeof(clap_event_param_value_t)) return false;
            const auto& event = *reinterpret_cast<const clap_event_param_value_t*>(header);
            // Global track envelopes cannot represent per-note modulation.
            if (event.note_id != -1 || event.port_index != -1 || event.channel != -1 || event.key != -1)
                return true;
            if (const auto found = parametersById.find(event.param_id); found != parametersById.end())
                {
                    found->second->publishNativeValue(event.value, (header->flags & CLAP_EVENT_DONT_RECORD) == 0);
                    return true;
                }
        }
        else
        {
            if (header->size < sizeof(clap_event_param_gesture_t)) return false;
            const auto& event = *reinterpret_cast<const clap_event_param_gesture_t*>(header);
            if (const auto found = parametersById.find(event.param_id); found != parametersById.end())
                {
                    found->second->publishGesture(header->type == CLAP_EVENT_PARAM_GESTURE_BEGIN);
                    return true;
                }
        }
        return false;
    }
    static constexpr size_t maxMidiEvents = 4096;
    struct InputEventsContext
    {
        std::vector<clap_event_midi_t> midiEvents;
        std::vector<clap_event_param_value_t> parameterEvents;
        struct Header { const clap_event_header_t* header; size_t order; };
        std::vector<Header> headers;
    } inContext;
    CLAPAutomationInputQueue automationInput;
    std::atomic<uint64_t> droppedMidiEvents { 0 };
    LibHandle libHandle = nullptr;
    const clap_plugin_t* clapPlugin = nullptr;
    const clap_plugin_params_t* paramsExt = nullptr;
    const clap_plugin_gui_t* guiExt = nullptr;
    juce::Array<CLAPParameter*> clapParams; // Non-owning — AudioProcessor owns them via addParameter
    std::map<clap_id, CLAPParameter*> parametersById;
    juce::Array<juce::var> parameterClears;
    juce::PluginDescription pluginDescription;
    std::atomic<bool> activated { false };
    double currentSampleRate = 44100.0;
    int currentBlockSize = 512;
    std::unique_ptr<CLAPHostContext> hostContext;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(CLAPPluginInstance)
};

//==============================================================================
// CLAPPluginFormat implementation
//==============================================================================

#include "CLAPAutomationRegression.inc"

void flushOpenStudioCLAPParameterEvents(juce::AudioProcessor* processor, ProcessorSafety* safety)
{
    if (auto* instance = dynamic_cast<CLAPPluginInstance*>(processor))
    {
        const juce::ScopedTryLock guard(instance->getCallbackLock());
        if (guard.isLocked() && (!safety || safety->failure.load(std::memory_order_acquire) == ProcessorSafety::Failure::none))
        {
            try { instance->flushParameterRequests(); }
            catch (...)
            {
                if (safety) safety->markFailure(ProcessorSafety::Failure::exception);
                else OpenStudioCrashDiagnostics::recordRealtimeFault(OpenStudioCrashDiagnostics::RealtimeFault::processorException);
            }
        }
    }
}

CLAPPluginFormat::CLAPPluginFormat() = default;
bool getOpenStudioCLAPParameterRange(juce::AudioProcessor* processor, int index, double& minimum, double& maximum)
{
    if (!processor || !juce::isPositiveAndBelow(index, processor->getParameters().size())) return false;
    if (const auto* parameter = dynamic_cast<const CLAPParameter*>(processor->getParameters()[index]))
    {
        minimum = parameter->getNativeMinimum(); maximum = parameter->getNativeMaximum(); return true;
    }
    return false;
}
CLAPPluginFormat::~CLAPPluginFormat() = default;
bool getOpenStudioCLAPParameterReferenceGeneration(juce::AudioProcessor* processor, int index, uint64_t& generation)
{
    if (!processor || !juce::isPositiveAndBelow(index, processor->getParameters().size())) return false;
    if (const auto* parameter = dynamic_cast<const CLAPParameter*>(processor->getParameters()[index]))
    { generation = parameter->getReferenceGeneration(); return true; }
    return false;
}
juce::Array<juce::var> takeOpenStudioCLAPParameterClears(juce::AudioProcessor* processor)
{
    if (auto* instance = dynamic_cast<CLAPPluginInstance*>(processor)) return instance->takeParameterClears();
    return {};
}

bool CLAPPluginFormat::fileMightContainThisPluginType(const juce::String& fileOrIdentifier)
{
    return fileOrIdentifier.endsWithIgnoreCase(".clap");
}

juce::String CLAPPluginFormat::getNameOfPluginFromIdentifier(const juce::String& fileOrIdentifier)
{
    return juce::File(fileOrIdentifier).getFileNameWithoutExtension();
}

bool CLAPPluginFormat::pluginNeedsRescanning(const juce::PluginDescription& desc)
{
    return juce::File(desc.fileOrIdentifier).getLastModificationTime() != desc.lastFileModTime;
}

bool CLAPPluginFormat::doesPluginStillExist(const juce::PluginDescription& desc)
{
    return juce::File(desc.fileOrIdentifier).existsAsFile();
}

juce::FileSearchPath CLAPPluginFormat::getDefaultLocationsToSearch()
{
    juce::FileSearchPath paths;

#ifdef _WIN32
    paths.add(juce::File("C:\\Program Files\\Common Files\\CLAP"));
    paths.add(juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                  .getParentDirectory().getChildFile("Local").getChildFile("Programs").getChildFile("Common Files").getChildFile("CLAP"));
#elif __APPLE__
    paths.add(juce::File("/Library/Audio/Plug-Ins/CLAP"));
    paths.add(juce::File::getSpecialLocation(juce::File::userHomeDirectory)
                  .getChildFile("Library/Audio/Plug-Ins/CLAP"));
#else
    paths.add(juce::File("/usr/lib/clap"));
    paths.add(juce::File::getSpecialLocation(juce::File::userHomeDirectory)
                  .getChildFile(".clap"));
#endif

    return paths;
}

juce::StringArray CLAPPluginFormat::searchPathsForPlugins(const juce::FileSearchPath& directoriesToSearch,
                                                           bool recursive, bool allowAsync)
{
    juce::ignoreUnused(allowAsync);
    juce::StringArray results;

    for (int i = 0; i < directoriesToSearch.getNumPaths(); ++i)
    {
        auto dir = directoriesToSearch[i];
        if (!dir.isDirectory()) continue;

        juce::Array<juce::File> files;
        dir.findChildFiles(files, juce::File::findFiles, recursive, "*.clap");

        for (const auto& f : files)
            results.add(f.getFullPathName());
    }

    return results;
}

void CLAPPluginFormat::findAllTypesForFile(juce::OwnedArray<juce::PluginDescription>& results,
                                            const juce::String& fileOrIdentifier)
{
    juce::File file(fileOrIdentifier);
    if (!file.existsAsFile())
    {
        logClapDiagnostic("Scan skipped because the file does not exist: " + fileOrIdentifier);
        return;
    }

    // Load the shared library
    juce::String loadError;
    LibHandle lib = loadLib(fileOrIdentifier, loadError);
    if (!lib)
    {
        logClapDiagnostic("Failed to load '" + fileOrIdentifier + "': "
                          + (loadError.isNotEmpty() ? loadError : "unknown loader error"));
        return;
    }

    auto* entry = (const clap_plugin_entry_t*)getSymbol(lib, "clap_entry");
    if (!entry)
    {
        logClapDiagnostic("Missing clap_entry symbol in: " + fileOrIdentifier);
        freeLib(lib);
        return;
    }

    if (!clap_version_is_compatible(entry->clap_version))
    {
        logClapDiagnostic("Incompatible CLAP version in: " + fileOrIdentifier);
        freeLib(lib);
        return;
    }

    if (entry->init == nullptr || entry->deinit == nullptr || entry->get_factory == nullptr)
    {
        logClapDiagnostic("Incomplete CLAP entry callbacks in: " + fileOrIdentifier);
        freeLib(lib);
        return;
    }

    if (!entry->init(fileOrIdentifier.toRawUTF8()))
    {
        logClapDiagnostic("CLAP entry initialization failed for: " + fileOrIdentifier);
        freeLib(lib);
        return;
    }

    auto* factory = (const clap_plugin_factory_t*)entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
    if (factory == nullptr)
    {
        logClapDiagnostic("No plugin factory was exposed by: " + fileOrIdentifier);
    }
    else if (factory->get_plugin_count == nullptr || factory->get_plugin_descriptor == nullptr)
    {
        logClapDiagnostic("Incomplete plugin factory callbacks in: " + fileOrIdentifier);
    }
    else
    {
        const uint32_t count = factory->get_plugin_count(factory);
        for (uint32_t i = 0; i < count; ++i)
        {
            auto* desc = factory->get_plugin_descriptor(factory, i);
            if (!desc) continue;

            auto* pd = new juce::PluginDescription();
            populateClapDescription(*pd, *desc, file, count > 1);

            results.add(pd);
        }
    }

    entry->deinit();
    freeLib(lib);
}

void CLAPPluginFormat::createPluginInstance(const juce::PluginDescription& desc,
                                            double initialSampleRate, int initialBufferSize,
                                            PluginCreationCallback callback)
{
    juce::ignoreUnused(initialSampleRate, initialBufferSize);

    juce::String fileOrId = desc.fileOrIdentifier;

    juce::String loadError;
    LibHandle lib = loadLib(fileOrId, loadError);
    if (!lib)
    {
        const auto message = "Failed to load CLAP library '" + fileOrId + "': "
                           + (loadError.isNotEmpty() ? loadError : "unknown loader error");
        logClapDiagnostic(message);
        callback(nullptr, message);
        return;
    }

    auto* entry = (const clap_plugin_entry_t*)getSymbol(lib, "clap_entry");
    if (!entry)
    {
        freeLib(lib);
        const auto message = "Missing clap_entry symbol in: " + fileOrId;
        logClapDiagnostic(message);
        callback(nullptr, message);
        return;
    }

    if (!clap_version_is_compatible(entry->clap_version))
    {
        freeLib(lib);
        const auto message = "Incompatible CLAP version in: " + fileOrId;
        logClapDiagnostic(message);
        callback(nullptr, message);
        return;
    }

    if (entry->init == nullptr || entry->deinit == nullptr || entry->get_factory == nullptr)
    {
        freeLib(lib);
        const auto message = "Incomplete CLAP entry callbacks in: " + fileOrId;
        logClapDiagnostic(message);
        callback(nullptr, message);
        return;
    }

    if (!entry->init(fileOrId.toRawUTF8()))
    {
        freeLib(lib);
        const auto message = "CLAP entry initialization failed for: " + fileOrId;
        logClapDiagnostic(message);
        callback(nullptr, message);
        return;
    }

    auto* factory = (const clap_plugin_factory_t*)entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
    if (!factory || factory->get_plugin_count == nullptr
                 || factory->get_plugin_descriptor == nullptr
                 || factory->create_plugin == nullptr)
    {
        entry->deinit();
        freeLib(lib);
        const auto message = "No valid CLAP plugin factory in: " + fileOrId;
        logClapDiagnostic(message);
        callback(nullptr, message);
        return;
    }

    // A CLAP module may expose multiple plugin classes. Never substitute another
    // class just because it lives in the same module.
    const uint32_t count = factory->get_plugin_count(factory);
    const int requestedId = desc.uniqueId != 0 ? desc.uniqueId : desc.deprecatedUid;
    std::vector<const clap_plugin_descriptor_t*> matchingDescriptors;

    for (uint32_t i = 0; i < count; ++i)
    {
        auto* pluginDesc = factory->get_plugin_descriptor(factory, i);
        if (pluginDesc == nullptr || pluginDesc->id == nullptr)
            continue;

        if (juce::String(pluginDesc->id).hashCode() == requestedId)
            matchingDescriptors.push_back(pluginDesc);
    }

    if (matchingDescriptors.size() > 1)
    {
        std::vector<const clap_plugin_descriptor_t*> metadataMatches;
        for (const auto* candidate : matchingDescriptors)
        {
            const bool nameMatches = desc.name.isEmpty()
                || juce::String(candidate->name ? candidate->name : "") == desc.name;
            const bool vendorMatches = desc.manufacturerName.isEmpty()
                || juce::String(candidate->vendor ? candidate->vendor : "") == desc.manufacturerName;

            if (nameMatches && vendorMatches)
                metadataMatches.push_back(candidate);
        }

        matchingDescriptors = std::move(metadataMatches);
    }

    if (matchingDescriptors.size() != 1)
    {
        entry->deinit();
        freeLib(lib);
        const auto reason = matchingDescriptors.empty()
            ? "was not found"
            : "is ambiguous because multiple classes have the same stored ID";
        const auto message = "Requested CLAP class '" + desc.name + "' (ID 0x"
                           + juce::String::toHexString(requestedId) + ") " + reason
                           + " in module: " + fileOrId;
        logClapDiagnostic(message);
        callback(nullptr, message);
        return;
    }

    const auto* matchedDescriptor = matchingDescriptors.front();
    auto host = std::make_unique<CLAPHostContext>();
    const clap_plugin_t* clapPlugin = factory->create_plugin(factory, &host->host, matchedDescriptor->id);

    if (!clapPlugin)
    {
        entry->deinit();
        freeLib(lib);
        const auto message = "CLAP factory failed to create class '"
                           + juce::String(matchedDescriptor->id) + "' from: " + fileOrId;
        logClapDiagnostic(message);
        callback(nullptr, message);
        return;
    }

    const auto missingCallbacks = getMissingClapPluginCallbacks(clapPlugin);
    if (missingCallbacks.isNotEmpty())
    {
        if (clapPlugin->destroy != nullptr)
            clapPlugin->destroy(clapPlugin);
        entry->deinit();
        freeLib(lib);
        const auto message = "CLAP class '" + juce::String(matchedDescriptor->id)
                           + "' is missing required fields/callbacks (" + missingCallbacks
                           + ") in: " + fileOrId;
        logClapDiagnostic(message);
        callback(nullptr, message);
        return;
    }

    const auto returnedClassId = clapPlugin->desc->id != nullptr
        ? juce::String(clapPlugin->desc->id)
        : juce::String();
    if (returnedClassId != juce::String(matchedDescriptor->id))
    {
        clapPlugin->destroy(clapPlugin);
        entry->deinit();
        freeLib(lib);
        const auto message = "CLAP factory returned class '" + returnedClassId
                           + "' when '" + juce::String(matchedDescriptor->id)
                           + "' was requested from: " + fileOrId;
        logClapDiagnostic(message);
        callback(nullptr, message);
        return;
    }

    if (!clapPlugin->init(clapPlugin))
    {
        clapPlugin->destroy(clapPlugin);
        entry->deinit();
        freeLib(lib);
        const auto message = "CLAP plugin initialization failed: " + fileOrId;
        logClapDiagnostic(message);
        callback(nullptr, message);
        return;
    }

    host->plugin = clapPlugin;

    auto instanceDescription = desc;
    populateClapDescription(instanceDescription,
                            *matchedDescriptor,
                            juce::File(fileOrId),
                            count > 1);
    instanceDescription.deprecatedUid = desc.deprecatedUid;
    updateClapChannelMetadata(*clapPlugin, instanceDescription);

    // Note: we do NOT call entry->deinit() here because the plugin is still alive.
    // The CLAPPluginInstance destructor handles cleanup.
    auto instance = std::make_unique<CLAPPluginInstance>(lib,
                                                         clapPlugin,
                                                         std::move(instanceDescription), std::move(host));
    callback(std::move(instance), {});
}
