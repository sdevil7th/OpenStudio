#pragma once

inline juce::var checkSendAutomation()
{
    TrackProcessor host;
    host.prepareToPlay(48000, 512);
    host.setForceAutomationReadForProcessing(true);
    TrackProcessor::SendConfig config;
    config.destTrackId = "bus_with_underscore";
    config.level = 0.0f;
    config.enabled = false;
    bool pass = host.replaceSends({ config });
    auto level = host.resolveAutomationTarget("send_bus_with_underscore_level", true);
    auto pan = host.resolveAutomationTarget("send_bus_with_underscore_pan", true);
    auto mute = host.resolveAutomationTarget("send_bus_with_underscore_mute", true);
    pass = pass && level && pan && mute && !host.resolveAutomationTarget("send_missing_level", true);
    if (level && pan && mute)
    {
        level->list->setMode(AutomationMode::Read);
        pan->list->setMode(AutomationMode::Read);
        mute->list->setMode(AutomationMode::Read);
        level->list->setPoints({ { 0, 0.25f }, { 1, 0.75f } });
        pan->list->setPoints({ { 0, 0.0f }, { 1, 1.0f } });
        mute->list->setPoints({ { 0, 0.0f }, { 0.5, 1.0f } });
        level->sendAutomation->bound.store(true);
        const auto send = host.getRealtimeSendSnapshot().front();
        juce::AudioBuffer<float> source(4, 512), destination(2, 512);
        for (int ch = 0; ch < 4; ++ch)
            juce::FloatVectorOperations::fill(source.getWritePointer(ch), ch < 2 ? 1.0f : 2.0f, 512);
        for (const double time : { 0.0, 0.25, 0.499, 0.5, 0.75 })
        {
            destination.clear();
            host.mixAutomatedSend(send, source, destination, 512, time, 48000);
            for (int i = 0; i < 512; ++i)
            {
                const auto position = time + static_cast<double>(i) / 48000;
                const auto gain = position >= 0.5 ? 0.0 : 0.25 + position * 0.5;
                const auto angle = position * juce::MathConstants<double>::halfPi;
                pass = pass && std::abs(destination.getSample(0, i) - gain * std::cos(angle)) < 1.0e-6
                    && std::abs(destination.getSample(1, i) - gain * std::sin(angle)) < 1.0e-6;
            }
        }
        auto pair = send;
        pair.sourceChannel = 2;
        pair.phaseInvert = true;
        destination.clear();
        host.mixAutomatedSend(pair, source, destination, 512, 0.0, 48000);
        pass = pass && std::abs(destination.getSample(0, 0) + 0.5f) < 1.0e-6;
        level->list->setMode(AutomationMode::Off);
        pan->list->setMode(AutomationMode::Off);
        mute->list->setMode(AutomationMode::Off);
        destination.clear();
        host.mixAutomatedSend(send, source, destination, 512, 0.0, 48000);
        pass = pass && destination.getMagnitude(0, 512) == 0.0f;
        host.replaceSends({});
        pass = pass && !host.resolveAutomationTarget("send_bus_with_underscore_level", false);
        host.replaceSends({ config });
        pass = pass && host.resolveAutomationTarget("send_bus_with_underscore_level", false)->list == level->list;
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Send gain/pan/mute playback and destination ownership");
    result->setProperty("pass", pass);
    return juce::var(result);
}

inline juce::var checkTrackMutePointTiming()
{
    TrackProcessor host;
    auto& lane = host.getMuteAutomation();
    lane.setPoints({ { 0, 0.0f }, { 1, 1.0f } });
    float block[64] {};
    lane.evalBlock(0.75, 48000, 64, block);
    bool pass = lane.eval(0.75) == 0.0f && lane.eval(1.0) == 1.0f;
    for (const float value : block) pass = pass && value == 0.0f;
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Track mute holds until the next automation point");
    result->setProperty("pass", pass);
    return juce::var(result);
}

inline juce::var checkJSFXAutomation()
{
    juce::Array<juce::var> diagnostics;
    const auto script = juce::File::getSpecialLocation(juce::File::tempDirectory)
        .getChildFile("OpenStudio-jsfx-automation-" + juce::Uuid().toString() + ".jsfx");
    bool pass = script.replaceWithText("desc:JSFX automation fixture\nslider1:1<0,1,0.001>Gain\n"
        "slider2:0<0,1,1{Off,On}>Script edit\n@block\nslider2 > 0 ? (slider1=0.6; slider_automate(slider1));\n"
        "@sample\nspl0 *= slider1; spl1 *= slider1;\n");
    int readChecks = 0;
    for (const bool input : { false, true })
    {
        TrackProcessor host;
        host.prepareToPlay(48000, 64);
        auto processor = std::make_unique<JSFXProcessor>();
        auto* plugin = processor.get();
        pass = processor->loadScript(script.getFullPathName()) && pass;
        pass = (input ? host.addInputFX(std::move(processor), 48000, 64)
                      : host.addTrackFX(std::move(processor), 48000, 64)) && pass;
        PluginParameterCapture capture(input ? host.getInputFXProcessorShared(0) : host.getTrackFXProcessorShared(0));
        host.setForceAutomationReadForProcessing(true);
        const auto prefix = "plugin_" + juce::String(input ? "input" : "track") + "_0_";
        auto target = host.resolveAutomationTarget(prefix + "0", true);
        const bool rejectedUnused = !host.resolveAutomationTarget(prefix + "3", true);
        pass = pass && target && !host.resolveAutomationTarget(prefix + "3", true);
        if (!target) continue;
        target->list->setMode(AutomationMode::Read);
        target->list->setPoints({ { 0, 0.2f }, { 1, 0.8f } });
        juce::AudioBuffer<float> audio(2, 64);
        juce::MidiBuffer midi;
        for (const double time : { 0.0, 1.0 })
        {
            plugin->setSliderValue(0, 0.45);
            capture.discard();
            host.setCurrentBlockPosition(time);
            for (int ch = 0; ch < 2; ++ch) juce::FloatVectorOperations::fill(audio.getWritePointer(ch), 1.0f, 64);
            host.processBlock(audio, midi);
            const auto expected = time == 0.0 ? 0.2f : 0.8f;
            pass = pass && std::abs(plugin->getParameters()[0]->getValue() - expected) < 1.0e-5f;
            pass = pass && std::abs(audio.getSample(0, 63) - expected) < 1.0e-4f;
            juce::Array<juce::var> edits;
            capture.drain("track", input, 0, edits);
            auto* detail = new juce::DynamicObject();
            detail->setProperty("input", input);
            detail->setProperty("time", time);
            detail->setProperty("normalized", plugin->getParameters()[0]->getValue());
            detail->setProperty("output", audio.getSample(0, 63));
            detail->setProperty("rejectedUnused", rejectedUnused);
            detail->setProperty("events", juce::var(edits));
            diagnostics.add(juce::var(detail));
            pass = pass && edits.isEmpty(); // Host Read never records its own setter.
            ++readChecks;
        }
        target->list->setMode(AutomationMode::Off);
        plugin->setSliderValue(1, 1.0);
        capture.discard();
        audio.clear();
        host.processBlock(audio, midi);
        juce::Array<juce::var> edits;
        capture.drain("track", input, 0, edits);
        bool scriptEdit = false;
        for (const auto& edit : edits)
            scriptEdit = scriptEdit || (edit["param"].toString() == prefix + "0"
                && edit["phase"].toString() == "value" && std::abs(static_cast<float>(edit["value"]) - 0.6f) < 1.0e-5f);
        pass = pass && scriptEdit;
        auto* detail = new juce::DynamicObject();
        detail->setProperty("input", input);
        detail->setProperty("scriptEdit", scriptEdit);
        detail->setProperty("events", juce::var(edits));
        diagnostics.add(juce::var(detail));
    }
    script.deleteFile();
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "JSFX host parameter Read and script automation notifications");
    result->setProperty("readChecks", readChecks);
    result->setProperty("diagnostics", juce::var(diagnostics));
    result->setProperty("pass", pass);
    return juce::var(result);
}

inline juce::var checkFallbackAutomation()
{
    TrackProcessor host;
    host.setTrackType(TrackType::Instrument);
    host.prepareToPlay(48000, 64);
    host.setForceAutomationReadForProcessing(true);
    bool pass = !host.resolveAutomationTarget("builtin_instrument_0_instrumentMode", true);
    int readChecks = 0;
    juce::AudioBuffer<float> audio(2, 64);
    juce::MidiBuffer midi;
    for (const auto& control : fallbackAutomationControls)
    {
        auto target = host.resolveAutomationTarget("builtin_instrument_0_" + juce::String(control.id), true);
        pass = pass && target.has_value();
        if (!target) continue;
        target->list->setMode(AutomationMode::Read);
        target->list->setPoints({ { 0, 0.1f }, { 1, 0.9f } });
        for (const double time : { 0.0, 0.75, 1.0 })
        {
            host.setFallbackInstrumentParam(control.id, control.minimum);
            host.setCurrentBlockPosition(time);
            audio.clear();
            midi.clear();
            host.processBlock(audio, midi);
            const auto normalized = target->list->eval(time);
            auto expected = control.minimum + normalized * (control.maximum - control.minimum);
            if (control.discrete) expected = std::round(expected);
            pass = pass && std::abs(host.getFallbackInstrumentParam(control.id) - expected) < 0.001f;
            ++readChecks;
        }
        target->list->setMode(AutomationMode::Off);
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Fallback instrument scalar automation");
    result->setProperty("readChecks", readChecks);
    result->setProperty("pass", pass);
    return juce::var(result);
}

// Exercise the real TrackProcessor envelope route, not just the editor setter.
// Scalar publication/finite output are objective checks; sound quality is not.
inline juce::var checkFreePluginAutomationRegistry()
{
    auto factories = freeSuiteFactories();
    factories.push_back({ "NAM Rack", [] { return std::make_unique<OpenStudioNAMRack>(); } });
    juce::Array<juce::var> cases;
    bool passed = true;
    for (const auto& entry : factories)
        for (const bool input : { false, true })
        {
            auto host = std::make_unique<TrackProcessor>();
            host->prepareToPlay(48000, 64);
            auto processor = entry.second();
            auto* plugin = processor.get();
            const auto schema = describeFreePluginForRegression(*plugin);
            const bool mounted = input ? host->addInputFX(std::move(processor), 48000, 64)
                                       : host->addTrackFX(std::move(processor), 48000, 64);
            host->setForceAutomationReadForProcessing(true);
            juce::AudioBuffer<float> audio(2, 64);
            juce::MidiBuffer midi;
            midi.ensureSize(8192);
            int eligible = 0, excluded = 0, readChecks = 0, discreteChecks = 0;
            bool metadata = mounted, resolved = mounted, playback = mounted, finite = true;
            juce::StringArray failures, excludedIds;
            if (const auto* parameters = schema["parameters"].getArray())
                for (const auto& parameter : *parameters)
                {
                    const auto id = parameter["id"].toString();
                    OpenStudioBuiltInAutomationDescriptor descriptor;
                    const bool supported = getOpenStudioBuiltInAutomationDescriptor(plugin, id, descriptor);
                    const bool advertised = static_cast<bool>(parameter["automatable"]);
                    metadata = metadata && supported == advertised;
                    const auto routeId = "builtin_" + juce::String(input ? "input" : "track") + "_0_" + juce::URL::addEscapeChars(id, true);
                    auto target = host->resolveAutomationTarget(routeId, true);
                    if (!supported)
                    {
                        ++excluded;
                        excludedIds.add(id);
                        resolved = resolved && !target.has_value();
                        continue;
                    }
                    ++eligible;
                    if (!target.has_value() || target->list == nullptr)
                    {
                        resolved = false;
                        failures.add(id + ": route rejected");
                        continue;
                    }
                    auto& lane = *target->list;
                    for (const float normalized : { 0.23f, 0.79f })
                    {
                        const bool wrote = setFreePluginNormalizedForRegression(*plugin, id, normalized);
                        OpenStudioBuiltInAutomationDescriptor expected;
                        const bool described = getOpenStudioBuiltInAutomationDescriptor(plugin, id, expected);
                        // First establish a different manual value. Read must reclaim it.
                        setFreePluginNormalizedForRegression(*plugin, id, 0.46f);
                        host->invalidatePluginAutomationCache();
                        lane.setPoints({ { 0, normalized }, { 1, normalized } });
                        lane.setMode(AutomationMode::Read);
                        host->setCurrentBlockPosition(0.25);
                        for (int channel = 0; channel < 2; ++channel)
                            for (int sample = 0; sample < 64; ++sample)
                                audio.setSample(channel, sample, 0.025f * std::sin(static_cast<float>(sample) * 0.071f));
                        midi.clear();
                        host->processBlock(audio, midi);
                        OpenStudioBuiltInAutomationDescriptor actual;
                        const bool read = getOpenStudioBuiltInAutomationDescriptor(plugin, id, actual);
                        const float tolerance = juce::jmax(0.00002f, std::abs(expected.currentValue) * 0.00002f);
                        const bool matches = wrote && described && read
                            && std::isfinite(actual.currentValue)
                            && std::abs(actual.currentValue - expected.currentValue) <= tolerance;
                        ++readChecks;
                        if (!matches)
                            failures.add(id + ": n=" + juce::String(normalized)
                                + " expected=" + juce::String(expected.currentValue)
                                + " actual=" + juce::String(actual.currentValue));
                        playback = playback && matches;
                        for (int channel = 0; channel < audio.getNumChannels(); ++channel)
                            for (int sample = 0; sample < audio.getNumSamples(); ++sample)
                                finite = finite && std::isfinite(audio.getSample(channel, sample));
                    }
                    if (descriptor.discrete)
                    {
                        lane.setPoints({ { 0, 0.0f }, { 1, 1.0f } });
                        for (const double time : { 0.75, 1.0 })
                        {
                            const float normalized = time < 1.0 ? 0.0f : 1.0f;
                            setFreePluginNormalizedForRegression(*plugin, id, normalized);
                            OpenStudioBuiltInAutomationDescriptor expected, actual;
                            getOpenStudioBuiltInAutomationDescriptor(plugin, id, expected);
                            setFreePluginNormalizedForRegression(*plugin, id, 0.46f);
                            host->invalidatePluginAutomationCache();
                            host->setCurrentBlockPosition(time);
                            audio.clear(); midi.clear(); host->processBlock(audio, midi);
                            const bool matches = getOpenStudioBuiltInAutomationDescriptor(plugin, id, actual)
                                && actual.currentValue == expected.currentValue;
                            playback = playback && matches;
                            ++discreteChecks;
                            if (!matches) failures.add(id + ": discrete point timing at " + juce::String(time));
                        }
                    }
                    lane.setMode(AutomationMode::Off);
                    lane.clear();
                }
            else metadata = false;
            auto* result = new juce::DynamicObject();
            result->setProperty("plugin", entry.first);
            result->setProperty("chain", input ? "input" : "track");
            result->setProperty("eligible", eligible);
            result->setProperty("excluded", excluded);
            result->setProperty("readChecks", readChecks);
            result->setProperty("discreteChecks", discreteChecks);
            result->setProperty("metadata", metadata);
            result->setProperty("routeResolution", resolved);
            result->setProperty("readPlayback", playback);
            result->setProperty("finiteOutput", finite);
            result->setProperty("failures", juce::var(failures));
            result->setProperty("excludedIds", juce::var(excludedIds));
            const bool pass = metadata && resolved && playback && finite && eligible > 0;
            result->setProperty("pass", pass);
            passed = passed && pass;
            cases.add(juce::var(result));
        }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Free suite automation registry and envelope playback");
    result->setProperty("pass", passed);
    result->setProperty("cases", cases);
    result->setProperty("audioQuality", "not_asserted");
    return juce::var(result);
}

inline juce::var checkVendorAutomationRegistry()
{
    const auto path = juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_FX_REGRESSION_PLUGIN", "");
    PluginManager manager;
    juce::Array<juce::var> cases;
    bool passed = path.isNotEmpty();
    for (const bool input : { false, true })
    {
        auto host = std::make_unique<TrackProcessor>();
        host->prepareToPlay(48000, 64);
        auto processor = path.isNotEmpty() ? manager.loadPluginFromFile(path, 48000, 64) : nullptr;
        auto* plugin = processor.get();
        const bool mounted = processor && (input ? host->addInputFX(std::move(processor), 48000, 64)
                                                : host->addTrackFX(std::move(processor), 48000, 64));
        host->setForceAutomationReadForProcessing(true);
        juce::AudioBuffer<float> audio(2, 64);
        juce::MidiBuffer midi;
        juce::StringArray failures;
        juce::Array<juce::var> parameters;
        int eligible = 0, readChecks = 0, gestureChecks = 0;
        bool pass = mounted;
        int processingModeChecks = 0;
        int processingPrecisionChecks = 0;
        if (mounted && path.endsWithIgnoreCase(".vst3"))
        {
            const auto rate = plugin->getSampleRate();
            const auto block = plugin->getBlockSize();
            const bool originalMode = plugin->isNonRealtime();
            for (const bool offline : { !originalMode, originalMode })
            {
                plugin->setNonRealtime(offline);
                plugin->prepareToPlay(rate, block);
                // VST3 ProcessModes: realtime=0, prefetch=1, offline=2.
                const bool modeMatches = juce::openStudioVST3PreparedProcessMode(*plugin) == (offline ? 2 : 0)
                    && juce::openStudioVST3PreparedSampleSize(*plugin) == (plugin->isUsingDoublePrecision() ? 1 : 0);
                pass = pass && modeMatches; ++processingModeChecks;
                if (!modeMatches) failures.add("Same-rate/block SDK processing mode was stale or rejected");
            }
            if (plugin->supportsDoublePrecisionProcessing())
            {
                const auto originalPrecision = plugin->getProcessingPrecision();
                const auto alternate = originalPrecision == juce::AudioProcessor::doublePrecision
                    ? juce::AudioProcessor::singlePrecision : juce::AudioProcessor::doublePrecision;
                for (const auto precision : { alternate, originalPrecision })
                {
                    plugin->setProcessingPrecision(precision);
                    plugin->prepareToPlay(rate, block);
                    const bool sizeMatches = juce::openStudioVST3PreparedSampleSize(*plugin)
                        == (precision == juce::AudioProcessor::doublePrecision ? 1 : 0);
                    pass = pass && sizeMatches; ++processingPrecisionChecks;
                    if (!sizeMatches) failures.add("Same-rate/block SDK sample precision was stale");
                }
            }
        }
        if (mounted)
            for (int index = 0; index < plugin->getParameters().size(); ++index)
            {
                auto* parameter = plugin->getParameters()[index];
                const auto name = parameter->getName(128);
                const auto lower = name.toLowerCase();
                if (!parameter->isAutomatable() || lower.startsWith("midi cc") || lower.startsWith("cc #")
                    || lower.contains("midi cc ") || lower.contains("midi ch")
                    || (static_cast<int>(parameter->getCategory()) >> 16) == 2) continue;
                ++eligible;
                const auto id = "plugin_" + juce::String(input ? "input" : "track") + "_0_" + juce::String(index);
                const auto target = host->resolveAutomationTarget(id, true);
                if (!target.has_value() || target->list == nullptr) { pass = false; failures.add(name + ": route rejected"); continue; }
                for (const float normalized : { 0.23f, 0.79f })
                {
                    parameter->setValue(normalized);
                    const float expected = parameter->getValue();
                    parameter->setValue(0.46f);
                    host->invalidatePluginAutomationCache();
                    target->list->setPoints({ { 0, normalized }, { 1, normalized } });
                    target->list->setMode(AutomationMode::Read);
                    host->setCurrentBlockPosition(0.25);
                    audio.clear(); midi.clear();
                    host->processBlock(audio, midi);
                    bool matches = std::isfinite(parameter->getValue()) && std::abs(parameter->getValue() - expected) < 0.002f;
                    for (int channel = 0; channel < audio.getNumChannels(); ++channel)
                        for (int sample = 0; sample < audio.getNumSamples(); ++sample)
                            matches = matches && std::isfinite(audio.getSample(channel, sample));
                    if (!matches) failures.add(name + ": envelope playback");
                    pass = pass && matches; ++readChecks;
                }
                target->list->setMode(AutomationMode::Off);
                juce::Array<juce::var> discarded;
                host->drainPluginParameterEdits("vendor", discarded);
                parameter->beginChangeGesture();
                parameter->setValueNotifyingHost(0.63f);
                parameter->endChangeGesture();
                juce::Array<juce::var> events;
                host->drainPluginParameterEdits("vendor", events);
                bool began = false, changed = false, ended = false;
                for (const auto& event : events)
                    if (event["param"].toString() == id)
                    {
                        began = began || event["phase"].toString() == "begin";
                        changed = changed || event["phase"].toString() == "value";
                        ended = ended || event["phase"].toString() == "end";
                    }
                const bool captured = began && changed && ended;
                pass = pass && captured; ++gestureChecks;
                if (!captured) failures.add(name + ": gesture capture");
                auto* item = new juce::DynamicObject();
                item->setProperty("index", index); item->setProperty("name", name);
                item->setProperty("value", parameter->getValue()); item->setProperty("text", parameter->getCurrentValueAsText());
                parameters.add(juce::var(item));
            }
        pass = pass && eligible > 0;
        auto* item = new juce::DynamicObject();
        item->setProperty("chain", input ? "input" : "track");
        item->setProperty("eligible", eligible); item->setProperty("readChecks", readChecks);
        item->setProperty("gestureChecks", gestureChecks); item->setProperty("pass", pass);
        item->setProperty("processingModeChecks", processingModeChecks);
        item->setProperty("processingPrecisionChecks", processingPrecisionChecks);
        item->setProperty("parameters", parameters); item->setProperty("failures", juce::var(failures));
        cases.add(juce::var(item)); passed = passed && pass;
    }
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Installed vendor envelope playback and JUCE editor capture");
    result->setProperty("path", path); result->setProperty("pass", passed); result->setProperty("cases", cases);
    result->setProperty("audibleParameterMapping", "not_asserted");
    return juce::var(result);
}

inline juce::var checkVST3SampleQueues()
{
    auto* result = new juce::DynamicObject(); result->setProperty("plugin", "Pinned JUCE VST3 sample-offset queues");
    result->setProperty("pass", juce::openStudioVST3AutomationQueueSelfTest());
    result->setProperty("scope", "Bounded SDK input/output queues and offsets; vendor DSP interpolation is not asserted");
    return juce::var(result);
}
