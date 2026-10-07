namespace
{
struct CLAPAutomationFixture
{
    clap_plugin_t plugin {};
    clap_plugin_params_t parameters {};
    double gain = 0.2, choice = 0, extra = 0;
    int topology = 0, activations = 0, deactivations = 0;
    bool renamed = false;
    int phase = 0, received = 0;
    bool validHostEvents = true, allowTimedEvents = false;
    std::array<std::pair<uint32_t, double>, 256> hostPoints {};
    size_t hostPointCount = 0;

    static CLAPAutomationFixture& fixture(const clap_plugin_t* p)
    { return *static_cast<CLAPAutomationFixture*>(p->plugin_data); }
    void emit(const clap_output_events_t* out)
    {
        if (phase == 0) return;
        if (phase == 4)
        {
            for (int point = 0; point < 3; ++point)
            {
                clap_event_param_value_t event {};
                event.header.size = sizeof(event); event.header.type = CLAP_EVENT_PARAM_VALUE;
                event.header.time = static_cast<uint32_t>(point == 0 ? 2 : point == 1 ? 17 : 49);
                event.note_id = -1; event.port_index = -1; event.channel = -1; event.key = -1;
                event.param_id = 3; event.value = point == 0 ? .2 : point == 1 ? .8 : .3;
                out->try_push(out, &event.header);
            }
            phase = 0;
            return;
        }
        if (phase == 1 || phase == 2)
        {
            clap_event_param_gesture_t event {};
            event.header.size = sizeof(event);
            event.header.type = static_cast<uint16_t>(phase == 1 ? CLAP_EVENT_PARAM_GESTURE_BEGIN : CLAP_EVENT_PARAM_GESTURE_END);
            event.param_id = 0;
            out->try_push(out, &event.header);
        }
        if (phase != 2)
        {
            clap_event_param_value_t event {};
            event.header.size = sizeof(event);
            event.header.type = CLAP_EVENT_PARAM_VALUE;
            event.header.flags = phase == 3 ? CLAP_EVENT_DONT_RECORD : 0;
            event.note_id = -1; event.port_index = -1; event.channel = -1; event.key = -1;
            event.param_id = 0;
            event.value = gain;
            out->try_push(out, &event.header);
        }
        phase = 0;
    }
    CLAPAutomationFixture()
    {
        plugin.plugin_data = this;
        plugin.destroy = [](const clap_plugin_t*) {};
        plugin.activate = [](const clap_plugin_t* p, double, uint32_t, uint32_t) { ++fixture(p).activations; return true; };
        plugin.deactivate = [](const clap_plugin_t* p) { ++fixture(p).deactivations; };
        plugin.start_processing = [](const clap_plugin_t*) { return true; };
        plugin.stop_processing = [](const clap_plugin_t*) {};
        plugin.on_main_thread = [](const clap_plugin_t*) {};
        plugin.get_extension = [](const clap_plugin_t* p, const char* id) -> const void*
        { return std::strcmp(id, CLAP_EXT_PARAMS) == 0 ? &fixture(p).parameters : nullptr; };
        plugin.process = [](const clap_plugin_t* p, const clap_process_t* process) -> clap_process_status
        {
            auto& f = fixture(p);
            uint32_t nextEvent = 0;
            for (uint32_t sample = 0; sample < process->frames_count; ++sample)
            {
                while (nextEvent < process->in_events->size(process->in_events))
                {
                    const auto* header = process->in_events->get(process->in_events, nextEvent);
                    if (header->time > sample) break;
                    ++nextEvent;
                    if (header->type != CLAP_EVENT_PARAM_VALUE) continue;
                const auto& event = *reinterpret_cast<const clap_event_param_value_t*>(header);
                f.validHostEvents = f.validHostEvents && (f.allowTimedEvents || header->time == 0) && header->space_id == CLAP_CORE_EVENT_SPACE_ID
                    && event.note_id == -1 && event.port_index == -1 && event.channel == -1 && event.key == -1;
                if (event.param_id == 0) f.gain = event.value;
                if (event.param_id == 1) f.choice = event.value;
                if (event.param_id == 3) f.extra = event.value;
                if (event.param_id == 3 && f.hostPointCount < f.hostPoints.size()) f.hostPoints[f.hostPointCount++] = { header->time, event.value };
                ++f.received;
                }
                for (uint32_t channel = 0; channel < process->audio_outputs[0].channel_count; ++channel)
                    process->audio_outputs[0].data32[channel][sample] *= static_cast<float>(f.topology ? f.extra : f.gain);
            }
            f.emit(process->out_events);
            return CLAP_PROCESS_CONTINUE;
        };
        parameters.count = [](const clap_plugin_t*) -> uint32_t { return 3; };
        parameters.get_info = [](const clap_plugin_t* p, uint32_t index, clap_param_info_t* info)
        {
            if (index > 2) return false;
            *info = {};
            const auto id = fixture(p).topology ? index == 0 ? 1u : index == 1 ? 3u : 2u : index;
            info->id = id;
            info->flags = id == 2 ? CLAP_PARAM_IS_READONLY : CLAP_PARAM_IS_AUTOMATABLE;
            if (id == 1) info->flags |= CLAP_PARAM_IS_STEPPED;
            info->min_value = 0;
            info->max_value = id == 1 ? 3 : 1;
            info->default_value = id == 0 ? 0.2 : 0;
            juce::String(id == 0 ? "Gain" : id == 1 ? fixture(p).renamed ? "Renamed Choice" : "Choice" : id == 3 ? "Extra" : "Meter").copyToUTF8(info->name, sizeof(info->name));
            return true;
        };
        parameters.get_value = [](const clap_plugin_t* p, clap_id id, double* value)
        { *value = id == 0 ? fixture(p).gain : id == 1 ? fixture(p).choice : id == 3 ? fixture(p).extra : 0; return id <= 3; };
        parameters.flush = [](const clap_plugin_t* p, const clap_input_events_t*, const clap_output_events_t* out)
        { fixture(p).emit(out); };
    }
};
}

juce::var runOpenStudioCLAPAutomationRegression()
{
    CLAPAutomationFixture fixture;
    auto context = std::make_unique<CLAPHostContext>();
    context->plugin = &fixture.plugin;
    auto* host = context.get();
    juce::PluginDescription description;
    description.name = "CLAP protocol fixture";
    auto instance = std::make_shared<CLAPPluginInstance>(nullptr, &fixture.plugin, description, std::move(context));
    PluginParameterCapture capture(instance);
    instance->prepareToPlay(48000, 64);
    bool pass = instance->getParameters().size() == 3 && instance->getParameters()[0]->isAutomatable()
        && instance->getParameters()[1]->isDiscrete() && !instance->getParameters()[2]->isAutomatable();
    juce::AudioBuffer<float> audio(2, 64);
    juce::MidiBuffer midi;
    for (auto* parameter : { instance->getParameters()[0], instance->getParameters()[1] })
        parameter->setValue(parameter == instance->getParameters()[0] ? 0.3f : 0.63f);
    for (int channel = 0; channel < 2; ++channel) juce::FloatVectorOperations::fill(audio.getWritePointer(channel), 1.0f, 64);
    instance->processBlock(audio, midi);
    pass = pass && fixture.validHostEvents && fixture.received == 2 && std::abs(audio.getSample(0, 63) - 0.3f) < 1.0e-6f
        && fixture.choice == 2;
    instance->processBlock(audio, midi);
    pass = pass && fixture.received == 2;
    juce::Array<juce::var> events;
    capture.drain("track", false, 0, events);
    pass = pass && events.isEmpty();
    fixture.gain = 0.75;
    fixture.phase = 1;
    const auto* extension = static_cast<const clap_host_params_t*>(host->host.get_extension(&host->host, CLAP_EXT_PARAMS));
    extension->request_flush(&host->host);
    flushOpenStudioCLAPParameterEvents(instance.get());
    capture.drain("track", false, 0, events);
    pass = pass && events.size() == 2 && events[0]["phase"].toString() == "begin"
        && events[1]["phase"].toString() == "value" && capture.stateFor(0)->gesture.load()
        && std::abs(instance->getParameters()[0]->getValue() - 0.75f) < 1.0e-6f;
    events.clear();
    juce::Thread::sleep(220);
    capture.drain("track", false, 0, events);
    pass = pass && events.isEmpty() && capture.stateFor(0)->touching.load();
    fixture.phase = 2;
    extension->request_flush(&host->host);
    flushOpenStudioCLAPParameterEvents(instance.get());
    capture.drain("track", false, 0, events);
    pass = pass && events.size() == 1 && events[0]["phase"].toString() == "end";
    events.clear();
    fixture.gain = 0.4;
    fixture.phase = 3;
    extension->request_flush(&host->host);
    flushOpenStudioCLAPParameterEvents(instance.get());
    capture.drain("track", false, 0, events);
    pass = pass && events.isEmpty() && std::abs(instance->getParameters()[0]->getValue() - 0.4f) < 1.0e-6f;
    instance->releaseResources();
    fixture.phase = 1;
    extension->request_flush(&host->host);
    host->poll(0, false);
    capture.drain("track", false, 0, events);
    pass = pass && events.size() == 2;
    instance->getParameters()[0]->setValue(0.7f);
    capture.discard();
    events.clear();
    auto* originalChoice = instance->getParameters()[1];
    fixture.renamed = true;
    host->poll(CLAP_PARAM_RESCAN_INFO | CLAP_PARAM_RESCAN_TEXT, false);
    capture.drain("track", false, 0, events);
    const bool infoPass = originalChoice->getName(128) == "Renamed Choice" && events.size() == 1
        && events[0]["phase"].toString() == "metadata";
    instance->prepareToPlay(44100, 64);
    const auto activations = fixture.activations, deactivations = fixture.deactivations;
    host->poll(0, true);
    const bool restartPass = fixture.activations == activations + 1 && fixture.deactivations == deactivations + 1;
    fixture.topology = 1;
    host->poll(CLAP_PARAM_RESCAN_ALL, false);
    events.clear();
    capture.drain("track", false, 0, events);
    const bool topologyPass = instance->getParameters().size() == 4 && instance->getParameters()[1] == originalChoice
        && !instance->getParameters()[0]->isAutomatable() && instance->getParameters()[3]->isAutomatable()
        && dynamic_cast<juce::HostedAudioProcessorParameter*>(instance->getParameters()[3])->getParameterID() == "3"
        && std::count_if(events.begin(), events.end(), [](const juce::var& event) { return event["phase"].toString() == "metadata"; }) == 1
        && std::none_of(events.begin(), events.end(), [](const juce::var& event) { return event["phase"].toString() == "value"; });
    instance->getParameters()[3]->setValue(.25f);
    const auto received = fixture.received;
    instance->processBlock(audio, midi);
    const bool appendedPass = fixture.received == received + 1 && std::abs(fixture.extra - .25) < 1.0e-6;
    const auto clock = std::make_shared<PluginAutomationClock>();
    clock->update(10.0, 44100.0, true);
    PluginParameterCapture timedCapture(instance, clock);
    fixture.phase = 4;
    {
        const ScopedPluginAutomationProcessing processing(10.0, 44100.0);
        instance->processBlock(audio, midi);
    }
    events.clear();
    timedCapture.drain("track", false, 0, events);
    bool timingPass = events.size() == 3;
    for (int point = 0; point < juce::jmin(3, events.size()); ++point)
    {
        const int offset = point == 0 ? 2 : point == 1 ? 17 : 49;
        const double value = point == 0 ? .2 : point == 1 ? .8 : .3;
        timingPass = timingPass && events[point]["timing"].toString() == "sample"
            && std::abs(static_cast<double>(events[point]["capturedTime"]) - (10.0 + static_cast<double>(offset) / 44100.0)) < 1.0e-10
            && std::abs(static_cast<double>(events[point]["value"]) - value) < 1.0e-6;
    }
    PluginAutomationEventQueue boundedQueue;
    bool boundedPass = true;
    for (size_t index = 0; index < PluginAutomationEventQueue::capacity + 3; ++index)
    {
        PluginAutomationCapturedEvent item; item.parameter = static_cast<int>(index);
        boundedPass = boundedPass && boundedQueue.push(item) == (index < PluginAutomationEventQueue::capacity);
    }
    PluginAutomationCapturedEvent item;
    for (size_t index = 0; index < PluginAutomationEventQueue::capacity; ++index)
        boundedPass = boundedPass && boundedQueue.pop(item) && item.parameter == static_cast<int>(index);
    boundedPass = boundedPass && !boundedQueue.pop(item) && boundedQueue.push(item) && boundedQueue.pop(item);
    fixture.allowTimedEvents = true;
    fixture.hostPointCount = 0;
    AutomationList delivery;
    delivery.setPoints({ { 20.0, .2f }, { 20.0 + 17.0 / 48000.0, .8f }, { 20.0 + 49.0 / 48000.0, .3f } });
    bool deliveryPass = deliverPluginAutomationPoints(instance->getParameters()[3], delivery, 20.0, 48000.0, 64, timedCapture.stateFor(3));
    for (int channel = 0; channel < audio.getNumChannels(); ++channel) juce::FloatVectorOperations::fill(audio.getWritePointer(channel), 1.0f, audio.getNumSamples());
    instance->processBlock(audio, midi);
    for (int sample = 0; sample < 64; ++sample)
        deliveryPass = deliveryPass && std::abs(audio.getSample(0, sample) - delivery.eval(20.0 + static_cast<double>(sample) / 48000.0)) < 1.0e-6f;
    deliveryPass = deliveryPass && fixture.hostPointCount > 3 && fixture.validHostEvents;
    delivery.setInterpolation(AutomationInterpolation::Discrete);
    fixture.hostPointCount = 0;
    deliveryPass = deliverPluginAutomationPoints(instance->getParameters()[3], delivery, 20.0, 48000.0, 64, timedCapture.stateFor(3)) && deliveryPass;
    for (int channel = 0; channel < audio.getNumChannels(); ++channel) juce::FloatVectorOperations::fill(audio.getWritePointer(channel), 1.0f, audio.getNumSamples());
    instance->processBlock(audio, midi);
    for (int sample = 0; sample < 64; ++sample)
        deliveryPass = deliveryPass && std::abs(audio.getSample(0, sample) - (sample < 17 ? .2f : sample < 49 ? .8f : .3f)) < 1.0e-6f;
    deliveryPass = deliveryPass && fixture.hostPointCount == 4 && fixture.hostPoints[1].first == 17 && fixture.hostPoints[2].first == 49;
    const auto clearActivations = fixture.activations, clearDeactivations = fixture.deactivations;
    instance->getParameters()[3]->queueValueAtSampleOffset(.91f, 17);
    extension->clear(&host->host, 3, CLAP_PARAM_CLEAR_AUTOMATIONS);
    host->poll(0, false);
    events.clear(); timedCapture.drain("track", false, 0, events);
    uint64_t referenceGeneration = 0;
    bool clearPass = getOpenStudioCLAPParameterReferenceGeneration(instance.get(), 3, referenceGeneration) && referenceGeneration == 1
        && fixture.activations == clearActivations && fixture.deactivations == clearDeactivations
        && std::count_if(events.begin(), events.end(), [](const juce::var& event) { return event["phase"].toString() == "references-cleared" && event["param"].toString() == "plugin_track_0_3"; }) == 1;
    fixture.hostPointCount = 0; instance->processBlock(audio, midi);
    clearPass = clearPass && fixture.hostPointCount == 0;
    extension->clear(&host->host, 3, CLAP_PARAM_CLEAR_MODULATIONS);
    host->poll(0, false); events.clear(); timedCapture.drain("track", false, 0, events);
    getOpenStudioCLAPParameterReferenceGeneration(instance.get(), 3, referenceGeneration);
    clearPass = clearPass && referenceGeneration == 1 && events.isEmpty();
    extension->clear(&host->host, 3, CLAP_PARAM_CLEAR_ALL);
    host->poll(0, false); events.clear(); timedCapture.drain("track", false, 0, events);
    getOpenStudioCLAPParameterReferenceGeneration(instance.get(), 3, referenceGeneration);
    clearPass = clearPass && referenceGeneration == 2 && !timedCapture.stateFor(3)->touching.load();

    // Producers never retry a dropped edit. Verify bounded contention does not
    // corrupt accepted events, reorder a producer, or prevent queue reuse.
    PluginAutomationEventQueue concurrentQueue;
    constexpr size_t producerCount = 4, eventsPerProducer = 25000;
    std::array<std::thread, producerCount> producers;
    std::array<size_t, producerCount> accepted {}, lost {}, consumed {};
    std::array<int64_t, producerCount> previous { -1, -1, -1, -1 };
    std::array<std::vector<bool>, producerCount> seen;
    for (auto& entries : seen) entries.resize(eventsPerProducer, false);
    std::atomic<size_t> finished { 0 };
    for (size_t producer = 0; producer < producerCount; ++producer)
        producers[producer] = std::thread([&, producer] {
            for (size_t sequence = 0; sequence < eventsPerProducer; ++sequence)
            {
                PluginAutomationCapturedEvent event; event.parameter = static_cast<int>(producer); event.sequence = sequence;
                if (concurrentQueue.push(event)) ++accepted[producer]; else ++lost[producer];
            }
            finished.fetch_add(1, std::memory_order_release);
        });
    bool concurrentPass = true;
    const auto consume = [&](const PluginAutomationCapturedEvent& event) {
        const size_t producer = static_cast<size_t>(event.parameter), sequence = static_cast<size_t>(event.sequence);
        if (producer >= producerCount || sequence >= eventsPerProducer) { concurrentPass = false; return; }
        concurrentPass = concurrentPass && !seen[producer][sequence] && static_cast<int64_t>(sequence) > previous[producer];
        seen[producer][sequence] = true; previous[producer] = static_cast<int64_t>(sequence); ++consumed[producer];
    };
    while (finished.load(std::memory_order_acquire) != producerCount)
        if (concurrentQueue.pop(item)) consume(item); else std::this_thread::yield();
    for (auto& producer : producers) producer.join();
    while (concurrentQueue.pop(item)) consume(item);
    for (size_t producer = 0; producer < producerCount; ++producer)
        concurrentPass = concurrentPass && consumed[producer] == accepted[producer] && accepted[producer] + lost[producer] == eventsPerProducer;
    concurrentPass = concurrentPass && concurrentQueue.push(item) && concurrentQueue.pop(item);
    const auto graph = std::make_shared<juce::AudioProcessorGraph>();
    graph->setParameterTree(juce::AudioProcessorParameterGroup("root", "Root", "/",
        std::make_unique<juce::AudioParameterFloat>(juce::ParameterID("original", 1), "Original", 0.0f, 1.0f, .25f)));
    PluginParameterCapture replacementCapture(graph);
    const auto originalMeaning = pluginParameterMeaning(graph.get(), 0);
    graph->getParameters()[0]->beginChangeGesture(); graph->getParameters()[0]->setValueNotifyingHost(.6f);
    graph->setParameterTree(juce::AudioProcessorParameterGroup("root", "Root", "/",
        std::make_unique<juce::AudioParameterFloat>(juce::ParameterID("replacement", 1), "Replacement", 0.0f, 2.0f, .5f)));
    events.clear(); replacementCapture.drain("replacement", false, 0, events);
    bool replacementPass = events.size() == 1 && events[0]["phase"].toString() == "metadata"
        && !replacementCapture.stateFor(0)->touching.load() && originalMeaning != pluginParameterMeaning(graph.get(), 0);
    events.clear(); graph->getParameters()[0]->setValueNotifyingHost(.8f); replacementCapture.drain("replacement", false, 0, events);
    replacementPass = replacementPass && events.size() == 1 && events[0]["phase"].toString() == "value"
        && events[0]["metadata"]["hostParamId"].toString() == "replacement";
    pass = pass && infoPass && restartPass && topologyPass && appendedPass && timingPass && boundedPass && deliveryPass && clearPass && concurrentPass && replacementPass;
    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "CLAP host values, choice flags, editor gestures, flush and DONT_RECORD");
    result->setProperty("pass", pass);
    result->setProperty("metadataRescanPass", infoPass);
    result->setProperty("restartPass", restartPass);
    result->setProperty("stableTopologyPass", topologyPass);
    result->setProperty("appendedParameterPass", appendedPass);
    result->setProperty("sampleOffsetCapturePass", timingPass);
    result->setProperty("boundedQueuePass", boundedPass);
    result->setProperty("sampleOffsetDeliveryPass", deliveryPass);
    result->setProperty("clearReferencesPass", clearPass);
    result->setProperty("concurrentCaptureQueuePass", concurrentPass);
    result->setProperty("juceParameterReplacementCapturePass", replacementPass);
    result->setProperty("scope", "Native protocol and parameter-topology fixture; vendor CLAP GUI and audio-port topology are not asserted");
    return juce::var(result);
}
