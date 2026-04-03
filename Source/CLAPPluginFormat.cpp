#include "CLAPPluginFormat.h"
#include <cmath>
#include <cstring>

#ifdef _WIN32
  #include <windows.h>
  using LibHandle = HMODULE;
  static LibHandle loadLib(const char* path) { return LoadLibraryA(path); }
  static void* getSymbol(LibHandle h, const char* name) { return (void*)GetProcAddress(h, name); }
  static void freeLib(LibHandle h) { FreeLibrary(h); }
#else
  #include <dlfcn.h>
  using LibHandle = void*;
  static LibHandle loadLib(const char* path) { return dlopen(path, RTLD_LOCAL | RTLD_LAZY); }
  static void* getSymbol(LibHandle h, const char* name) { return dlsym(h, name); }
  static void freeLib(LibHandle h) { dlclose(h); }
#endif

//==============================================================================
// Minimal CLAP host implementation required by the CLAP API
//==============================================================================

static void hostRequestRestart(const clap_host_t*) {}
static void hostRequestProcess(const clap_host_t*) {}
static void hostRequestCallback(const clap_host_t*) {}

static const void* hostGetExtension(const clap_host_t*, const char*)
{
    return nullptr; // No host extensions for now
}

static clap_host_t makeHost()
{
    clap_host_t host{};
    host.clap_version = CLAP_VERSION;
    host.host_data = nullptr;
    host.name = "OpenStudio";
    host.vendor = "OpenStudio";
    host.url = "";
    host.version = "1.0.0";
    host.get_extension = hostGetExtension;
    host.request_restart = hostRequestRestart;
    host.request_process = hostRequestProcess;
    host.request_callback = hostRequestCallback;
    return host;
}

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
            {
                guiExt->create(clapPlugin, apiStr, false);
                guiCreated = true;
            }
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
        guiExt->set_parent(clapPlugin, &window);

        // Query preferred size
        uint32_t w = 0, h = 0;
        if (guiExt->get_size(clapPlugin, &w, &h) && w > 0 && h > 0)
            setSize(static_cast<int>(w), static_cast<int>(h));

        guiExt->show(clapPlugin);
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

class CLAPParameter : public juce::AudioPluginInstance::HostedParameter
{
public:
    CLAPParameter(const clap_plugin_t* plugin, const clap_plugin_params_t* paramsExt,
                   clap_id paramId, const juce::String& paramName,
                   double minVal, double maxVal, double defaultVal)
        : clapPlugin(plugin), paramsExtension(paramsExt)
        , id(paramId), parameterName(paramName)
        , rangeMin(minVal), rangeMax(maxVal), defaultValue(defaultVal)
    {
        currentValue = defaultVal;
    }

    float getValue() const override
    {
        if (rangeMax <= rangeMin) return 0.0f;
        return static_cast<float>((currentValue - rangeMin) / (rangeMax - rangeMin));
    }

    void setValue(float newValue) override
    {
        currentValue = rangeMin + static_cast<double>(newValue) * (rangeMax - rangeMin);
    }

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

    juce::String getParameterID() const override
    {
        return juce::String(static_cast<int64_t>(id));
    }

    float getValueForText(const juce::String& text) const override
    {
        double val = text.getDoubleValue();
        if (rangeMax <= rangeMin) return 0.0f;
        return juce::jlimit(0.0f, 1.0f, static_cast<float>((val - rangeMin) / (rangeMax - rangeMin)));
    }

    clap_id getClapId() const { return id; }
    double getNativeValue() const { return currentValue; }
    void setNativeValue(double v) { currentValue = v; }

private:
    const clap_plugin_t* clapPlugin;
    const clap_plugin_params_t* paramsExtension;
    clap_id id;
    juce::String parameterName;
    double rangeMin, rangeMax, defaultValue;
    double currentValue;
};

//==============================================================================
// CLAP Plugin Instance — wraps a clap_plugin_t as a juce::AudioProcessor
//==============================================================================

class CLAPPluginInstance : public juce::AudioPluginInstance
{
public:
    CLAPPluginInstance(LibHandle lib, const clap_plugin_t* plugin,
                       const juce::String& pluginName, const juce::String& vendorName,
                       const juce::String& fileOrId)
        : juce::AudioPluginInstance(BusesProperties()
              .withInput("Input", juce::AudioChannelSet::stereo(), true)
              .withOutput("Output", juce::AudioChannelSet::stereo(), true))
        , pluginFileOrId(fileOrId)
        , libHandle(lib)
        , clapPlugin(plugin)
        , name(pluginName)
        , vendor(vendorName)
    {
        if (clapPlugin)
        {
            clapPlugin->init(clapPlugin);

            // Discover parameters
            paramsExt = (const clap_plugin_params_t*)clapPlugin->get_extension(clapPlugin, CLAP_EXT_PARAMS);
            if (paramsExt)
            {
                uint32_t paramCount = paramsExt->count(clapPlugin);
                for (uint32_t i = 0; i < paramCount; ++i)
                {
                    clap_param_info_t info{};
                    if (paramsExt->get_info(clapPlugin, i, &info))
                    {
                        auto param = std::make_unique<CLAPParameter>(clapPlugin, paramsExt,
                                                                      info.id, juce::String(info.name),
                                                                      info.min_value, info.max_value,
                                                                      info.default_value);
                        clapParams.add(param.get());
                        addHostedParameter(std::move(param));
                    }
                }
            }

            // Check for GUI support
            guiExt = (const clap_plugin_gui_t*)clapPlugin->get_extension(clapPlugin, CLAP_EXT_GUI);
        }
    }

    ~CLAPPluginInstance() override
    {
        // CLAP spec requires deactivate before destroy. If releaseResources()
        // wasn't called (e.g., unexpected destruction path), do it now.
        if (clapPlugin && activated)
            releaseResources();

        if (clapPlugin)
        {
            clapPlugin->destroy(clapPlugin);
            clapPlugin = nullptr;
        }
        if (libHandle)
        {
            // Find entry and deinit
            auto* entryFn = (const clap_plugin_entry_t*)getSymbol(libHandle, "clap_entry");
            if (entryFn)
                entryFn->deinit();
            freeLib(libHandle);
            libHandle = nullptr;
        }
    }

    // --- AudioPluginInstance overrides ---

    void fillInPluginDescription(juce::PluginDescription& desc) const override
    {
        desc.name = name;
        desc.manufacturerName = vendor;
        desc.pluginFormatName = "CLAP";
        desc.fileOrIdentifier = pluginFileOrId;
        desc.category = "";
    }

    const juce::String getName() const override { return name; }

    void prepareToPlay(double sampleRate, int samplesPerBlock) override
    {
        if (!clapPlugin) return;

        // Activate the plugin
        clapPlugin->activate(clapPlugin, sampleRate, (uint32_t)samplesPerBlock, (uint32_t)samplesPerBlock);
        clapPlugin->start_processing(clapPlugin);
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
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages) override
    {
        if (!clapPlugin || !activated)
            return;

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

        if (auto* playHead = getPlayHead())
        {
            auto position = playHead->getPosition();
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

        struct InputEventsContext
        {
            std::vector<clap_event_midi_t> midiEvents;
            std::vector<const clap_event_header_t*> headers;
        };

        InputEventsContext inContext;
        inContext.midiEvents.reserve(static_cast<size_t>(midiMessages.getNumEvents()));
        inContext.headers.reserve(static_cast<size_t>(midiMessages.getNumEvents()));

        for (const auto metadata : midiMessages)
        {
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
            inContext.headers.push_back(&inContext.midiEvents.back().header);
        }

        clap_input_events_t inEvents{};
        inEvents.ctx = &inContext;
        inEvents.size = [](const clap_input_events_t* events) -> uint32_t {
            auto* ctx = static_cast<InputEventsContext*>(events->ctx);
            return static_cast<uint32_t>(ctx->headers.size());
        };
        inEvents.get = [](const clap_input_events_t* events, uint32_t index) -> const clap_event_header_t* {
            auto* ctx = static_cast<InputEventsContext*>(events->ctx);
            if (index >= ctx->headers.size())
                return nullptr;
            return ctx->headers[index];
        };
        process.in_events = &inEvents;

        struct OutputEventsContext
        {
            juce::MidiBuffer* midiBuffer = nullptr;
            int maxSamples = 0;
        };

        OutputEventsContext outContext { &midiMessages, numSamples };
        clap_output_events_t outEvents{};
        outEvents.ctx = &outContext;
        outEvents.try_push = [](const clap_output_events_t* events, const clap_event_header_t* header) -> bool {
            if (events == nullptr || header == nullptr)
                return false;

            auto* ctx = static_cast<OutputEventsContext*>(events->ctx);
            if (ctx == nullptr || ctx->midiBuffer == nullptr)
                return false;

            const int sampleOffset = juce::jlimit(0, juce::jmax(0, ctx->maxSamples - 1), static_cast<int>(header->time));

            switch (header->type)
            {
                case CLAP_EVENT_MIDI:
                {
                    auto* midi = reinterpret_cast<const clap_event_midi_t*>(header);
                    ctx->midiBuffer->addEvent(juce::MidiMessage(midi->data, 3), sampleOffset);
                    return true;
                }
                case CLAP_EVENT_NOTE_ON:
                {
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
        stateExt->load(clapPlugin, &stream);
    }

private:
    LibHandle libHandle = nullptr;
    const clap_plugin_t* clapPlugin = nullptr;
    const clap_plugin_params_t* paramsExt = nullptr;
    const clap_plugin_gui_t* guiExt = nullptr;
    juce::Array<CLAPParameter*> clapParams; // Non-owning — AudioProcessor owns them via addParameter
    juce::String name;
    juce::String vendor;
    juce::String pluginFileOrId;
    bool activated = false;
    double currentSampleRate = 44100.0;
    int currentBlockSize = 512;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(CLAPPluginInstance)
};

//==============================================================================
// CLAPPluginFormat implementation
//==============================================================================

CLAPPluginFormat::CLAPPluginFormat() = default;
CLAPPluginFormat::~CLAPPluginFormat() = default;

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
    juce::ignoreUnused(desc);
    return false;
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
    if (!file.existsAsFile()) return;

    // Load the shared library
    LibHandle lib = loadLib(fileOrIdentifier.toRawUTF8());
    if (!lib) return;

    auto* entry = (const clap_plugin_entry_t*)getSymbol(lib, "clap_entry");
    if (!entry || !clap_version_is_compatible(entry->clap_version))
    {
        freeLib(lib);
        return;
    }

    entry->init(fileOrIdentifier.toRawUTF8());

    auto* factory = (const clap_plugin_factory_t*)entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
    if (factory)
    {
        uint32_t count = factory->get_plugin_count(factory);
        for (uint32_t i = 0; i < count; ++i)
        {
            auto* desc = factory->get_plugin_descriptor(factory, i);
            if (!desc) continue;

            auto* pd = new juce::PluginDescription();
            pd->name = desc->name ? desc->name : "Unknown";
            pd->manufacturerName = desc->vendor ? desc->vendor : "Unknown";
            pd->descriptiveName = desc->description ? desc->description : "";
            pd->version = desc->version ? desc->version : "";
            pd->pluginFormatName = "CLAP";
            pd->fileOrIdentifier = fileOrIdentifier;
            pd->uniqueId = juce::String(desc->id ? desc->id : "").hashCode();
            pd->category = "";

            // Parse features for category
            if (desc->features)
            {
                juce::StringArray features;
                for (int f = 0; desc->features[f] != nullptr; ++f)
                    features.add(desc->features[f]);

                if (features.contains(CLAP_PLUGIN_FEATURE_INSTRUMENT))
                    pd->category = "Instrument";
                else if (features.contains(CLAP_PLUGIN_FEATURE_AUDIO_EFFECT))
                    pd->category = "Effect";
                else if (features.contains(CLAP_PLUGIN_FEATURE_ANALYZER))
                    pd->category = "Analyzer";

                pd->isInstrument = features.contains(CLAP_PLUGIN_FEATURE_INSTRUMENT);
            }

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

    LibHandle lib = loadLib(fileOrId.toRawUTF8());
    if (!lib)
    {
        callback(nullptr, "Failed to load CLAP library: " + fileOrId);
        return;
    }

    auto* entry = (const clap_plugin_entry_t*)getSymbol(lib, "clap_entry");
    if (!entry || !clap_version_is_compatible(entry->clap_version))
    {
        freeLib(lib);
        callback(nullptr, "Invalid CLAP entry point in: " + fileOrId);
        return;
    }

    entry->init(fileOrId.toRawUTF8());

    auto* factory = (const clap_plugin_factory_t*)entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
    if (!factory)
    {
        entry->deinit();
        freeLib(lib);
        callback(nullptr, "No CLAP factory in: " + fileOrId);
        return;
    }

    // Find the matching plugin by uniqueId
    const clap_plugin_t* clapPlugin = nullptr;
    juce::String pluginName = desc.name;
    juce::String vendorName = desc.manufacturerName;

    uint32_t count = factory->get_plugin_count(factory);
    for (uint32_t i = 0; i < count; ++i)
    {
        auto* pluginDesc = factory->get_plugin_descriptor(factory, i);
        if (!pluginDesc) continue;

        int id = juce::String(pluginDesc->id ? pluginDesc->id : "").hashCode();
        if (id == desc.uniqueId)
        {
            static clap_host_t host = makeHost();
            clapPlugin = factory->create_plugin(factory, &host, pluginDesc->id);
            break;
        }
    }

    if (!clapPlugin)
    {
        // Try first plugin as fallback
        if (count > 0)
        {
            auto* pluginDesc = factory->get_plugin_descriptor(factory, 0);
            if (pluginDesc)
            {
                static clap_host_t host = makeHost();
                clapPlugin = factory->create_plugin(factory, &host, pluginDesc->id);
            }
        }
    }

    if (!clapPlugin)
    {
        entry->deinit();
        freeLib(lib);
        callback(nullptr, "Failed to create CLAP plugin from: " + fileOrId);
        return;
    }

    // Note: we do NOT call entry->deinit() here because the plugin is still alive.
    // The CLAPPluginInstance destructor handles cleanup.
    auto instance = std::make_unique<CLAPPluginInstance>(lib, clapPlugin, pluginName, vendorName, fileOrId);
    callback(std::move(instance), {});
}
