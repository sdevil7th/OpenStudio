#include "S13FXProcessor.h"
#include "S13FXGfxEditor.h"

S13FXProcessor::S13FXProcessor()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
    config = ysfx_config_new();
    ysfx_register_builtin_audio_formats(config);
}

S13FXProcessor::~S13FXProcessor()
{
    if (effect)
        ysfx_free(effect);
    if (config)
        ysfx_config_free(config);
}

bool S13FXProcessor::loadScript(const juce::String& path)
{
    // Free any existing effect
    if (effect)
    {
        ysfx_free(effect);
        effect = nullptr;
    }

    scriptPath = path;

    // Set import/data roots based on script location
    ysfx_guess_file_roots(config, path.toRawUTF8());

    // Create new effect instance
    effect = ysfx_new(config);
    if (!effect)
    {
        juce::Logger::writeToLog("S13FXProcessor: Failed to create YSFX instance");
        return false;
    }

    // Load the script file
    if (!ysfx_load_file(effect, path.toRawUTF8(), 0))
    {
        juce::Logger::writeToLog("S13FXProcessor: Failed to load script: " + path);
        ysfx_free(effect);
        effect = nullptr;
        return false;
    }

    // Compile the script
    if (!ysfx_compile(effect, 0))
    {
        juce::Logger::writeToLog("S13FXProcessor: Failed to compile script: " + path);
        ysfx_free(effect);
        effect = nullptr;
        return false;
    }

    // Cache the effect name
    const char* name = ysfx_get_name(effect);
    effectName = name ? juce::String(name) : juce::File(path).getFileNameWithoutExtension();

    // Set sample rate and block size if we've already been prepared
    if (cachedSampleRate > 0)
    {
        ysfx_set_sample_rate(effect, cachedSampleRate);
        ysfx_set_block_size(effect, static_cast<uint32_t>(cachedBlockSize));
        ysfx_init(effect);
    }

    juce::Logger::writeToLog("S13FXProcessor: Loaded script: " + effectName +
                             " (ins=" + juce::String(ysfx_get_num_inputs(effect)) +
                             " outs=" + juce::String(ysfx_get_num_outputs(effect)) + ")");
    return true;
}

bool S13FXProcessor::reloadScript()
{
    if (scriptPath.isEmpty())
        return false;

    // Save current slider state
    std::vector<std::pair<uint32_t, double>> savedSliders;
    if (effect && ysfx_is_compiled(effect))
    {
        for (uint32_t i = 0; i < ysfx_max_sliders; ++i)
        {
            if (ysfx_slider_exists(effect, i))
                savedSliders.push_back({ i, ysfx_slider_get_value(effect, i) });
        }
    }

    // Reload the script
    if (!loadScript(scriptPath))
        return false;

    // Restore slider values
    for (auto& [idx, val] : savedSliders)
    {
        if (ysfx_slider_exists(effect, idx))
            ysfx_slider_set_value(effect, idx, val);
    }

    return true;
}

bool S13FXProcessor::isScriptLoaded() const
{
    return effect != nullptr && ysfx_is_compiled(effect);
}

std::vector<S13FXProcessor::SliderInfo> S13FXProcessor::getSliders() const
{
    std::vector<SliderInfo> sliders;

    if (!effect || !ysfx_is_compiled(effect))
        return sliders;

    for (uint32_t i = 0; i < ysfx_max_sliders; ++i)
    {
        if (!ysfx_slider_exists(effect, i))
            continue;

        SliderInfo info;
        info.index = i;

        const char* name = ysfx_slider_get_name(effect, i);
        info.name = name ? juce::String(name) : ("Slider " + juce::String(i));

        ysfx_slider_range_t range;
        if (ysfx_slider_get_range(effect, i, &range))
        {
            info.min = range.min;
            info.max = range.max;
            info.def = range.def;
            info.inc = range.inc;
        }
        else
        {
            info.min = 0.0;
            info.max = 1.0;
            info.def = 0.0;
            info.inc = 0.001;
        }

        info.value = ysfx_slider_get_value(effect, i);
        info.isEnum = ysfx_slider_is_enum(effect, i);

        if (info.isEnum)
        {
            uint32_t enumSize = ysfx_slider_get_enum_size(effect, i);
            for (uint32_t e = 0; e < enumSize; ++e)
            {
                const char* ename = ysfx_slider_get_enum_name(effect, i, e);
                info.enumNames.add(ename ? juce::String(ename) : "");
            }
        }

        sliders.push_back(std::move(info));
    }

    return sliders;
}

bool S13FXProcessor::setSliderValue(uint32_t index, double value)
{
    if (!effect || !ysfx_is_compiled(effect))
        return false;

    if (!ysfx_slider_exists(effect, index))
        return false;

    ysfx_slider_set_value(effect, index, value);
    return true;
}

// ---- juce::AudioProcessor overrides ----

void S13FXProcessor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    cachedSampleRate = sampleRate;
    cachedBlockSize = samplesPerBlock;

    if (effect && ysfx_is_compiled(effect))
    {
        ysfx_set_sample_rate(effect, sampleRate);
        ysfx_set_block_size(effect, static_cast<uint32_t>(samplesPerBlock));
        ysfx_set_midi_capacity(effect, 1024, true);
        ysfx_init(effect);
    }

    // Pre-allocate temp buffer for channel adaptation
    int maxChannels = juce::jmax(2, getTotalNumInputChannels(), getTotalNumOutputChannels());
    tempBuffer.setSize(maxChannels, samplesPerBlock);
}

void S13FXProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    if (!effect || !ysfx_is_compiled(effect))
        return;

    const int numSamples = buffer.getNumSamples();
    const int bufferChannels = buffer.getNumChannels();

    // Feed MIDI events to YSFX
    for (const auto metadata : midiMessages)
    {
        const auto msg = metadata.getMessage();
        ysfx_midi_event_t event {};
        event.bus = 0;
        event.offset = static_cast<uint32_t>(metadata.samplePosition);
        event.size = static_cast<uint32_t>(msg.getRawDataSize());
        event.data = msg.getRawData();
        ysfx_send_midi(effect, &event);
    }

    // Update time info from the playhead
    updateTimeInfo();

    // Determine channel counts for YSFX
    uint32_t ysfxIns = ysfx_get_num_inputs(effect);
    uint32_t ysfxOuts = ysfx_get_num_outputs(effect);

    // Ensure we have at least 2 channels for processing
    if (ysfxIns == 0) ysfxIns = 2;
    if (ysfxOuts == 0) ysfxOuts = 2;

    uint32_t maxCh = juce::jmax(ysfxIns, ysfxOuts, static_cast<uint32_t>(bufferChannels));

    // Resize temp buffer if needed
    if (tempBuffer.getNumChannels() < static_cast<int>(maxCh) || tempBuffer.getNumSamples() < numSamples)
        tempBuffer.setSize(static_cast<int>(maxCh), numSamples, false, false, true);

    // Copy input data into temp buffer
    for (int ch = 0; ch < static_cast<int>(maxCh); ++ch)
    {
        if (ch < bufferChannels)
            tempBuffer.copyFrom(ch, 0, buffer, ch, 0, numSamples);
        else
            tempBuffer.clear(ch, 0, numSamples);
    }

    // Set up channel pointer arrays
    inputPtrs.resize(ysfxIns);
    outputPtrs.resize(ysfxOuts);

    for (uint32_t ch = 0; ch < ysfxIns; ++ch)
        inputPtrs[ch] = tempBuffer.getReadPointer(static_cast<int>(ch < maxCh ? ch : 0));

    for (uint32_t ch = 0; ch < ysfxOuts; ++ch)
        outputPtrs[ch] = tempBuffer.getWritePointer(static_cast<int>(ch < maxCh ? ch : 0));

    // Process audio through YSFX
    ysfx_process_float(effect, inputPtrs.data(), outputPtrs.data(),
                       ysfxIns, ysfxOuts, static_cast<uint32_t>(numSamples));

    // Copy output back to the JUCE buffer
    for (int ch = 0; ch < bufferChannels; ++ch)
    {
        if (ch < static_cast<int>(ysfxOuts))
            buffer.copyFrom(ch, 0, tempBuffer, ch, 0, numSamples);
        else
            buffer.clear(ch, 0, numSamples);
    }

    // Receive MIDI output from YSFX
    midiMessages.clear();
    ysfx_midi_event_t outEvent {};
    while (ysfx_receive_midi(effect, &outEvent))
    {
        if (outEvent.size > 0 && outEvent.size <= 3)
        {
            auto msg = juce::MidiMessage(outEvent.data, static_cast<int>(outEvent.size));
            midiMessages.addEvent(msg, static_cast<int>(outEvent.offset));
        }
    }
}

void S13FXProcessor::releaseResources()
{
    // Nothing to release — YSFX handles its own memory
}

const juce::String S13FXProcessor::getName() const
{
    return effectName.isNotEmpty() ? effectName : "S13FX";
}

void S13FXProcessor::getStateInformation(juce::MemoryBlock& destData)
{
    if (!effect || !ysfx_is_compiled(effect))
        return;

    // Save slider values as a simple binary format
    auto sliders = getSliders();
    juce::MemoryOutputStream stream(destData, false);

    // Write magic + version
    stream.writeInt(0x53313346); // "S13F"
    stream.writeInt(1);          // version

    // Write script path
    stream.writeString(scriptPath);

    // Write slider count and values
    stream.writeInt(static_cast<int>(sliders.size()));
    for (const auto& s : sliders)
    {
        stream.writeInt(static_cast<int>(s.index));
        stream.writeDouble(s.value);
    }
}

void S13FXProcessor::setStateInformation(const void* data, int sizeInBytes)
{
    juce::MemoryInputStream stream(data, static_cast<size_t>(sizeInBytes), false);

    int magic = stream.readInt();
    if (magic != 0x53313346) // "S13F"
        return;

    int version = stream.readInt();
    juce::ignoreUnused(version);

    juce::String path = stream.readString();

    // Load the script if not already loaded
    if (path.isNotEmpty() && (scriptPath.isEmpty() || !isScriptLoaded()))
        loadScript(path);

    // Read and apply slider values
    int sliderCount = stream.readInt();
    for (int i = 0; i < sliderCount; ++i)
    {
        uint32_t idx = static_cast<uint32_t>(stream.readInt());
        double val = stream.readDouble();
        setSliderValue(idx, val);
    }
}

bool S13FXProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    // Accept any layout — we handle channel adaptation in processBlock
    juce::ignoreUnused(layouts);
    return true;
}

bool S13FXProcessor::hasGfxSection() const
{
    return effect != nullptr && ysfx_has_section(effect, ysfx_section_gfx);
}

bool S13FXProcessor::hasEditor() const
{
    return hasGfxSection();
}

juce::AudioProcessorEditor* S13FXProcessor::createEditor()
{
    if (hasGfxSection())
        return new S13FXGfxEditor(*this);
    return nullptr;
}

void S13FXProcessor::updateTimeInfo()
{
    if (!effect)
        return;

    auto* ph = getPlayHead();
    if (!ph)
        return;

    auto posInfo = ph->getPosition();
    if (!posInfo.hasValue())
        return;

    ysfx_time_info_t timeInfo {};

    if (auto bpm = posInfo->getBpm())
        timeInfo.tempo = *bpm;
    else
        timeInfo.tempo = 120.0;

    timeInfo.playback_state = posInfo->getIsPlaying() ? 1 : 0;

    if (auto timeInSeconds = posInfo->getTimeInSeconds())
        timeInfo.time_position = *timeInSeconds;

    if (auto ppq = posInfo->getPpqPosition())
        timeInfo.beat_position = *ppq;

    if (auto timeSig = posInfo->getTimeSignature())
    {
        timeInfo.time_signature[0] = static_cast<uint32_t>(timeSig->numerator);
        timeInfo.time_signature[1] = static_cast<uint32_t>(timeSig->denominator);
    }
    else
    {
        timeInfo.time_signature[0] = 4;
        timeInfo.time_signature[1] = 4;
    }

    ysfx_set_time_info(effect, &timeInfo);
}
