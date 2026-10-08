    {
        const auto track = addTrack("editor-host-bypass", "audio");
        const int masterIndex = getMasterFX().size();
        bool pass = addTrackBuiltInFX(track, "OpenStudio Chorus", false)
            && addTrackBuiltInFX(track, "OpenStudio Chorus", true)
            && addMasterBuiltInFX("OpenStudio Chorus");
        for (const auto& chain : juce::StringArray{"track", "input", "master"})
        {
            const int index = chain == "master" ? masterIndex : 0;
            const auto schema = getBuiltInPluginSchema(track, chain, index);
            const auto identity = schema["instanceId"].toString();
            const auto state = getBuiltInPluginState(track, chain, index)["fullState"].toString();
            pass = !identity.isEmpty() && !static_cast<bool>(schema["hostBypassed"]) && pass;
            pass = setBuiltInPluginState(track, chain, index, R"json({"hostBypassed":true})json")
                && static_cast<bool>(getBuiltInPluginSchema(track, chain, index)["hostBypassed"])
                && getBuiltInPluginState(track, chain, index)["fullState"].toString() == state && pass;
            pass = !setBuiltInPluginState(track, chain, index, R"json({"hostBypassed":1})json")
                && static_cast<bool>(getBuiltInPluginSchema(track, chain, index)["hostBypassed"]) && pass;
            pass = setBuiltInPluginState(track, chain, index, R"json({"hostBypassed":false})json")
                && !static_cast<bool>(getBuiltInPluginSchema(track, chain, index)["hostBypassed"])
                && resolveBuiltInPluginRoute(track, chain, index, identity) == index && pass;
            const auto slots = chain == "master" ? getMasterFX() : (chain == "input" ? getTrackInputFX(track) : getTrackFX(track));
            pass = slots[index]["instanceId"].toString() == identity && pass;
        }
        addCheck("editor_host_bypass_native_contexts", pass,
            "Track/input/master bypass readback and list identity agree; host bypass leaves complete DSP state intact and malformed writes are rejected.");
        removeMasterFX(masterIndex); removeTrack(track);
    }
