    {
        bool pass = true;
        for (const auto& name : juce::StringArray{"OpenStudio Graphic EQ", "OpenStudio Compressor", "OpenStudio Gate",
                 "OpenStudio Limiter", "OpenStudio Preamp", "OpenStudio Saturator", "OpenStudio Reverb", "OpenStudio Delay",
                 "OpenStudio Chorus", "OpenStudio Gain Phase", "OpenStudio Pitch Correct", "OpenStudio Basic Synth",
                 "OpenStudio Piano", "OpenStudio Clean Guitar", "OpenStudio Drums"})
        {
            auto processor = createBuiltInEffect(name);
            if (!processor) { pass = false; continue; }
            juce::MemoryBlock state; processor->getStateInformation(state);
            const auto file = outputDirectory.getChildFile(name.removeCharacters(" ") + ".ospreset");
            auto* object = new juce::DynamicObject(); const juce::var request(object);
            object->setProperty("pluginName",name); object->setProperty("path",file.getFullPathName());
            object->setProperty("fullState",state.toBase64Encoding());
            const auto exported = eqPresetLibrary("export",request);
            const auto imported = eqPresetLibrary("import",request);
            pass = static_cast<bool>(exported["success"]) && static_cast<bool>(imported["success"])
                && imported["state"]["name"].toString() == name
                && imported["state"]["fullState"].toString() == state.toBase64Encoding()
                && !static_cast<bool>(eqPresetLibrary("export",request)["success"]) && pass;
            object->setProperty("overwrite",true); object->setProperty("fullState","malformed");
            pass = !static_cast<bool>(eqPresetLibrary("export",request)["success"]) && pass;
            object->setProperty("pluginName",name == "OpenStudio Chorus" ? "OpenStudio Delay" : "OpenStudio Chorus");
            pass = !static_cast<bool>(eqPresetLibrary("import",request)["success"]) && pass;
            juce::MemoryBlock unchanged; pass = file.loadFileAsData(unchanged) && unchanged == state && pass;
        }
        addCheck("suite_preset_file_type_roundtrip",pass,
            "Fifteen non-EQ free-plugin file exports/imports preserve complete native bytes, reject wrong processor types and malformed replacement data, and require explicit overwrite.");
    }
