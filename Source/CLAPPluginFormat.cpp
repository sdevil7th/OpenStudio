#include "CLAPPluginFormat.h"

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
    host.name = "Studio13";
    host.vendor = "Studio13";
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
            clapPlugin->init(clapPlugin);
    }

    ~CLAPPluginInstance() override
    {
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
        juce::ignoreUnused(midiMessages);
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
        process.transport = nullptr;
        process.audio_inputs = &inputBuf;
        process.audio_outputs = &outputBuf;
        process.audio_inputs_count = 1;
        process.audio_outputs_count = 1;
        process.in_events = nullptr;
        process.out_events = nullptr;

        // Create empty event lists
        clap_input_events_t inEvents{};
        inEvents.ctx = nullptr;
        inEvents.size = [](const clap_input_events_t*) -> uint32_t { return 0; };
        inEvents.get = [](const clap_input_events_t*, uint32_t) -> const clap_event_header_t* { return nullptr; };
        process.in_events = &inEvents;

        clap_output_events_t outEvents{};
        outEvents.ctx = nullptr;
        outEvents.try_push = [](const clap_output_events_t*, const clap_event_header_t*) -> bool { return true; };
        process.out_events = &outEvents;

        clapPlugin->process(clapPlugin, &process);
    }

    double getTailLengthSeconds() const override { return 0.0; }

    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }

    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }

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
