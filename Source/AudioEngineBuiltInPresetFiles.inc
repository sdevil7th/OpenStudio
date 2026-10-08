    const auto pluginName = request["pluginName"].toString();
    if (pluginName.isNotEmpty() && pluginName != "OpenStudio EQ")
    {
        // The existing file bridge also serves the free suite. Startup defaults
        // and EQ metadata remain in the EQ-specific path below.
        auto factory = createBuiltInEffect(pluginName);
        if (!factory || factory->getName() != pluginName || dynamic_cast<OpenStudioNAMRack*>(factory.get()))
            return fail("Choose a supported built-in effect");
        if (action != "import" && action != "export" && action != "folder")
            return fail("Unsupported preset file action");
        const auto directory = getPersistentBuiltInPresetsDir(pluginName);
        if (action == "folder")
        {
            if (!directory.createDirectory()) return fail("Could not create the preset folder");
            result->setProperty("path", directory.getFullPathName()); result->setProperty("success", true); return response;
        }
        juce::MemoryBlock defaults; factory->getStateInformation(defaults);
        const auto expected = juce::ValueTree::readFromData(defaults.getData(),defaults.getSize()).getType();
        const size_t maximum = pluginName == "OpenStudio Reverb" ? 64u*1024u*1024u : 40u*1024u*1024u;
        const auto valid = [&](const juce::MemoryBlock& data)
        {
            if (data.isEmpty() || data.getSize() > maximum) return false;
            const auto tree = juce::ValueTree::readFromData(data.getData(),data.getSize());
            return tree.isValid() && tree.getType() == expected;
        };
        const auto path = request["path"].toString();
        if (!juce::File::isAbsolutePath(path)) return fail("Choose a preset file");
        const juce::File file(path);
        if (!file.hasFileExtension("ospreset")) return fail("Preset files use the .ospreset extension");
        juce::MemoryBlock payload;
        if (action == "import")
        {
            if (!file.existsAsFile() || file.getSize() > static_cast<juce::int64>(maximum)
                || !file.loadFileAsData(payload) || !valid(payload))
                return fail("This preset does not contain supported settings for " + pluginName);
            auto* state = new juce::DynamicObject(); state->setProperty("name",pluginName);
            state->setProperty("fullState",payload.toBase64Encoding()); result->setProperty("state",juce::var(state));
        }
        else
        {
            const auto encoded = request["fullState"].toString();
            if (encoded.length() > 90*1024*1024 || !PluginStateValidation::decode(encoded,payload) || !valid(payload))
                return fail("Capture complete settings for " + pluginName + " first");
            if (file.exists() && !static_cast<bool>(request["overwrite"])) return fail("The export file already exists");
            if (!writeBuiltInPresetPayloadAtomically(file,payload)) return fail("Could not export the preset");
        }
        result->setProperty("success",true); return response;
    }
