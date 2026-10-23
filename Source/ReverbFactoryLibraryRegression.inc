    {
        bool listed = true, data = true, recall = true, copies = true, protectedEntries = true;
        bool collectionBrowse = true, diskPriority = true;
        int generatedCount = 0;
        const auto pluginName = juce::String("OpenStudio Reverb");
        const auto presets = getBuiltInFXPresets(pluginName);
        const auto factoryTrackId = addTrack("reverb-factory-regression-" + juce::Uuid().toString());
        recall = factoryTrackId.isNotEmpty() && addTrackBuiltInFX(factoryTrackId, pluginName);
        const auto factoryTrackEntry = trackMap.find(factoryTrackId);
        auto* factoryReverb = factoryTrackEntry != trackMap.end()
            ? dynamic_cast<OpenStudioReverb*>(factoryTrackEntry->second->getTrackFXProcessor(0)) : nullptr;
        for (const auto& voice : OpenStudioReverbFactoryPresets::voices)
        {
            bool found = false, generated = false;
            if (const auto* array = presets.getArray())
                for (const auto& preset : *array)
                    if (preset["name"].toString().equalsIgnoreCase(voice.name))
                    { found = true; generated = static_cast<bool>(preset["factory"]); }
            listed = found && listed;
            // A pre-existing same-name disk preset has deliberate priority. Never
            // overwrite/delete it in this regression; generated entry checks apply
            // only where the new factory entry is actually visible.
            if (! generated)
                continue;
            ++generatedCount;
            juce::MemoryBlock expected, actual;
            OpenStudioReverbFactoryPresets::buildState(voice.name, expected);
            const auto expectedTree = juce::ValueTree::readFromData(expected.getData(), expected.getSize());
            data = static_cast<float>(expectedTree["reverbReturnMode"]) == 1 && data;
            const auto encoded = getBuiltInFXPresetData(pluginName, voice.name);
            data = actual.fromBase64Encoding(encoded) && actual == expected && data;
            const auto suffix = voice.kind == OpenStudioReverbFactoryPresets::Kind::Collection ? juce::String("Voiced-collection")
                : (voice.kind == OpenStudioReverbFactoryPresets::Kind::Individual ? "Voiced-" : "") + juce::String(voice.type);
            const auto file = outputDirectory.getChildFile("ReverbFactory-" + suffix + ".ospreset");
            auto* fileRequest = new juce::DynamicObject();
            fileRequest->setProperty("pluginName", pluginName);
            fileRequest->setProperty("path", file.getFullPathName());
            fileRequest->setProperty("fullState", encoded);
            fileRequest->setProperty("overwrite", true);
            const juce::var request(fileRequest);
            const auto exported = eqPresetLibrary("export", request);
            const auto imported = eqPresetLibrary("import", request);
            data = static_cast<bool>(exported["success"]) && static_cast<bool>(imported["success"])
                && imported["state"]["fullState"].toString() == encoded && data;
            if (recall)
            {
                recall = setBuiltInPluginParam(factoryTrackId, "track", 0, "mixLock", 0)
                    && loadBuiltInFXPreset(factoryTrackId, "track", 0, voice.name) && recall;
                const auto state = getBuiltInPluginState(factoryTrackId, "track", 0);
                juce::MemoryBlock recalled;
                recall = recalled.fromBase64Encoding(state["fullState"].toString()) && recalled == expected && recall;
                if (voice.kind == OpenStudioReverbFactoryPresets::Kind::Collection)
                {
                    collectionBrowse = factoryReverb != nullptr && collectionBrowse;
                    for (const auto& profile : OpenStudioReverbFactoryPresets::profiles)
                    {
                        collectionBrowse = setBuiltInPluginParam(factoryTrackId, "track", 0, "reverbTypeAll", static_cast<float>(profile.type)) && collectionBrowse;
                        if (factoryReverb != nullptr)
                            for (size_t field = 0; field < profile.controls.size(); ++field)
                                collectionBrowse = factoryReverb->getBankValue(profile.type, static_cast<int>(field)) == profile.controls[field] && collectionBrowse;
                    }
                    collectionBrowse = setBuiltInPluginParam(factoryTrackId, "track", 0, "reverbTypeAll", 0) && collectionBrowse;
                    const auto browsed = getBuiltInPluginState(factoryTrackId, "track", 0);
                    juce::MemoryBlock browsedBytes;
                    collectionBrowse = browsedBytes.fromBase64Encoding(browsed["fullState"].toString()) && browsedBytes == expected && collectionBrowse;
                }
                recall = setBuiltInPluginParam(factoryTrackId, "track", 0, "wetLevel", .17f)
                    && setBuiltInPluginParam(factoryTrackId, "track", 0, "dryLevel", .81f)
                    && setBuiltInPluginParam(factoryTrackId, "track", 0, "mixLock", 1)
                    && setBuiltInPluginParam(factoryTrackId, "track", 0, "outputTrimDb", -11)
                    && loadBuiltInFXPreset(factoryTrackId, "track", 0, voice.name) && recall;
                const auto locked = getBuiltInPluginState(factoryTrackId, "track", 0);
                juce::MemoryBlock lockedBytes;
                const bool decoded = lockedBytes.fromBase64Encoding(locked["fullState"].toString());
                const auto tree = juce::ValueTree::readFromData(lockedBytes.getData(), lockedBytes.getSize());
                recall = decoded && static_cast<float>(tree["wetLevel"]) == .17f
                    && static_cast<float>(tree["dryLevel"]) == .81f && static_cast<float>(tree["mixLock"]) == 1
                    && static_cast<float>(tree["outputTrimDb"]) == voice.outputTrimDb
                    && static_cast<float>(tree["reverbReturnMode"]) == 1 && recall;
            }
            const auto copyName = "reverb-factory-copy-" + juce::Uuid().toString();
            const bool copied = copyBuiltInFXPreset(pluginName, voice.name, copyName);
            juce::MemoryBlock copiedBytes;
            copies = copied && copiedBytes.fromBase64Encoding(getBuiltInFXPresetData(pluginName, copyName))
                && copiedBytes == expected && copies;
            bool metadataCopied = false;
            const auto copiedPresets = getBuiltInFXPresets(pluginName);
            if (const auto* array = copiedPresets.getArray())
                for (const auto& preset : *array)
                    if (preset["name"].toString() == copyName)
                        metadataCopied = preset["metadata"]["character"].toString() == voice.character
                            && ! static_cast<bool>(preset["factory"]);
            copies = metadataCopied && copies;
            if (copied) copies = deleteBuiltInFXPreset(pluginName, copyName) && copies;
            protectedEntries = ! saveBuiltInFXPresetData(pluginName, voice.name, encoded)
                && ! copyBuiltInFXPreset(pluginName, voice.name, voice.name)
                && ! deleteBuiltInFXPreset(pluginName, voice.name) && protectedEntries;
            if (factoryTrackId.isNotEmpty())
                protectedEntries = ! saveBuiltInFXPreset(factoryTrackId, "track", 0, voice.name) && protectedEntries;
        }
        // A reserved generated display name can already exist in a user's old
        // library. Exercise that precedence in an isolated override, without
        // creating/replacing a file in the real user preset directories.
        {
            // Atomic preset writes create temporary siblings. Keep this test-only
            // path short enough for Windows even under a nested report root.
            const auto isolatedRoot = outputDirectory.getChildFile("rv-" + juce::Uuid().toString().substring(0,12));
            const auto persistentRoot = isolatedRoot.getChildFile("p");
            const auto legacyRoot = isolatedRoot.getChildFile("l");
            const juce::ScopedValueSetter<juce::File> persistentScope(builtInPresetPersistentRootOverride, persistentRoot);
            const juce::ScopedValueSetter<juce::File> legacyScope(builtInPresetLegacyRootOverride, legacyRoot);
            const auto directory = getPersistentBuiltInPresetsDir(pluginName);
            const auto collisionName = juce::String(OpenStudioReverbFactoryPresets::collection.name);
            const auto collisionFile = directory.getChildFile(collisionName + ".ospreset");
            juce::MemoryBlock userState, readBack;
            diskPriority = OpenStudioReverbFactoryPresets::buildState(OpenStudioReverbFactoryPresets::existingVoices[0].name, userState)
                && directory.createDirectory().wasOk() && writeBuiltInPresetPayloadAtomically(collisionFile, userState) && diskPriority;
            bool userListed = false;
            const auto precedencePresets = getBuiltInFXPresets(pluginName);
            if (const auto* array = precedencePresets.getArray())
                for (const auto& preset : *array)
                    if (preset["name"].toString() == collisionName) userListed = !static_cast<bool>(preset["factory"]);
            diskPriority = userListed && readBack.fromBase64Encoding(getBuiltInFXPresetData(pluginName, collisionName))
                && readBack == userState && diskPriority;
            diskPriority = setBuiltInPluginParam(factoryTrackId, "track", 0, "mixLock", 0)
                && loadBuiltInFXPreset(factoryTrackId, "track", 0, collisionName) && diskPriority;
            const auto recalled = getBuiltInPluginState(factoryTrackId, "track", 0);
            const bool priorityDecoded=readBack.fromBase64Encoding(recalled["fullState"].toString());
            auto* priorityEvidence=new juce::DynamicObject();
            priorityEvidence->setProperty("beforeRecallComparison",diskPriority);
            priorityEvidence->setProperty("decoded",priorityDecoded);
            priorityEvidence->setProperty("userListed",userListed);
            priorityEvidence->setProperty("sameState",readBack==userState);
            juce::Array<juce::var> differences;
            const auto expectedPriority=juce::ValueTree::readFromData(userState.getData(),userState.getSize());
            const auto actualPriority=juce::ValueTree::readFromData(readBack.getData(),readBack.getSize());
            for(int property=0;property<expectedPriority.getNumProperties();++property)
            {
                const auto name=expectedPriority.getPropertyName(property);
                if(expectedPriority[name]==actualPriority[name])continue;
                auto* difference=new juce::DynamicObject();difference->setProperty("property",name.toString());
                difference->setProperty("expected",expectedPriority[name].toString().substring(0,120));
                difference->setProperty("actual",actualPriority[name].toString().substring(0,120));differences.add(difference);
            }
            priorityEvidence->setProperty("differences",differences);
            outputDirectory.getChildFile("reverb-preset-priority-evidence.json").replaceWithText(juce::JSON::toString(juce::var(priorityEvidence)));
            diskPriority = priorityDecoded && readBack == userState && diskPriority;
            diskPriority = collisionFile.deleteFile() && diskPriority;
            (void) directory.deleteFile(); (void) persistentRoot.deleteFile();
            (void) legacyRoot.deleteFile(); (void) isolatedRoot.deleteFile();
        }
        bool refinementMigration = setBuiltInPluginParam(factoryTrackId, "track", 0, "reverbCharacterMode", 1);
        const auto refinementState = getBuiltInPluginState(factoryTrackId, "track", 0);
        refinementMigration = setBuiltInPluginState(factoryTrackId, "track", 0, "{\"factoryDefault\":true}") && refinementMigration;
        juce::MemoryBlock refinementBytes;
        refinementMigration = refinementBytes.fromBase64Encoding(refinementState["fullState"].toString()) && refinementMigration;
        auto refinementTree = juce::ValueTree::readFromData(refinementBytes.getData(), refinementBytes.getSize());
        refinementMigration = factoryReverb != nullptr && factoryReverb->reverbCharacterMode.load() == 0 && refinementMigration;
        refinementMigration = setBuiltInPluginState(factoryTrackId, "track", 0, juce::JSON::toString(refinementState))
            && factoryReverb != nullptr && factoryReverb->reverbCharacterMode.load() == 1 && refinementMigration;
        refinementTree.removeProperty("reverbCharacterMode", nullptr);
        juce::MemoryBlock preRefinementBytes;
        { juce::MemoryOutputStream stream(preRefinementBytes, false); refinementTree.writeToStream(stream); }
        auto* preRefinementObject = new juce::DynamicObject();
        preRefinementObject->setProperty("name", pluginName);
        preRefinementObject->setProperty("fullState", preRefinementBytes.toBase64Encoding());
        const auto migrationFile = outputDirectory.getChildFile("Reverb-Original-state.ospreset");
        auto* migrationRequest = new juce::DynamicObject();
        migrationRequest->setProperty("pluginName", pluginName); migrationRequest->setProperty("path", migrationFile.getFullPathName());
        migrationRequest->setProperty("fullState", preRefinementBytes.toBase64Encoding()); migrationRequest->setProperty("overwrite", true);
        const juce::var migrationFileRequest(migrationRequest);
        const auto migrationExport = eqPresetLibrary("export", migrationFileRequest);
        const auto migrationImport = eqPresetLibrary("import", migrationFileRequest);
        refinementMigration = static_cast<bool>(migrationExport["success"]) && static_cast<bool>(migrationImport["success"])
            && setBuiltInPluginState(factoryTrackId, "track", 0, juce::JSON::toString(juce::var(preRefinementObject)))
            && factoryReverb != nullptr && factoryReverb->reverbCharacterMode.load() == 0 && refinementMigration;

        bool returnMigration = factoryReverb != nullptr
            && setBuiltInPluginParam(factoryTrackId, "track", 0, "reverbReturnMode", 0);
        const auto returnState = getBuiltInPluginState(factoryTrackId, "track", 0);
        returnMigration = setBuiltInPluginState(factoryTrackId, "track", 0, "{\"factoryDefault\":true}")
            && factoryReverb != nullptr && factoryReverb->reverbReturnMode.load() == 1 && returnMigration;
        // This is the native complete-state JSON payload used by project FX
        // recall. It exercises JSON/base64 boundaries, not a frontend file UI.
        const auto projectPayload = juce::JSON::parse(juce::JSON::toString(returnState));
        returnMigration = setBuiltInPluginState(factoryTrackId, "track", 0, juce::JSON::toString(projectPayload))
            && factoryReverb != nullptr && factoryReverb->reverbReturnMode.load() == 0 && returnMigration;
        juce::MemoryBlock returnBytes;
        returnMigration = returnBytes.fromBase64Encoding(returnState["fullState"].toString()) && returnMigration;
        auto returnTree = juce::ValueTree::readFromData(returnBytes.getData(), returnBytes.getSize());
        returnTree.removeProperty("reverbReturnMode", nullptr);
        juce::MemoryBlock preReturnBytes;
        { juce::MemoryOutputStream stream(preReturnBytes, false); returnTree.writeToStream(stream); }
        const auto returnFile = outputDirectory.getChildFile("Reverb-Original-return-state.ospreset");
        auto* returnRequestObject = new juce::DynamicObject();
        returnRequestObject->setProperty("pluginName", pluginName); returnRequestObject->setProperty("path", returnFile.getFullPathName());
        returnRequestObject->setProperty("fullState", preReturnBytes.toBase64Encoding()); returnRequestObject->setProperty("overwrite", true);
        const juce::var returnRequest(returnRequestObject);
        const auto returnExport = eqPresetLibrary("export", returnRequest);
        const auto returnImport = eqPresetLibrary("import", returnRequest);
        returnMigration = static_cast<bool>(returnExport["success"]) && static_cast<bool>(returnImport["success"])
            && setBuiltInPluginParam(factoryTrackId, "track", 0, "reverbReturnMode", 1)
            && setBuiltInPluginState(factoryTrackId, "track", 0, juce::JSON::toString(returnImport["state"]))
            && factoryReverb != nullptr && factoryReverb->reverbReturnMode.load() == 0 && returnMigration;
        addCheck("reverb_return_state_migration", returnMigration,
            "Original return level recalls through project FX JSON and portable preset payloads; missing old state restores Original, while factory reset and new factory voices use Calibrated.");
        bool controlMigration = factoryReverb != nullptr
            && setBuiltInPluginParam(factoryTrackId, "track", 0, "reverbControlMode", 0);
        const auto controlsState = getBuiltInPluginState(factoryTrackId, "track", 0);
        controlMigration = setBuiltInPluginState(factoryTrackId, "track", 0, "{\"factoryDefault\":true}")
            && factoryReverb->reverbControlMode.load() == 1 && controlMigration;
        controlMigration = setBuiltInPluginState(factoryTrackId, "track", 0, juce::JSON::toString(controlsState))
            && factoryReverb->reverbControlMode.load() == 0 && controlMigration;
        juce::MemoryBlock controlsBytes; controlsBytes.fromBase64Encoding(controlsState["fullState"].toString());
        auto controlsTree = juce::ValueTree::readFromData(controlsBytes.getData(), controlsBytes.getSize());
        controlsTree.removeProperty("reverbControlMode", nullptr);
        juce::MemoryBlock oldControlsBytes;
        { juce::MemoryOutputStream stream(oldControlsBytes, false); controlsTree.writeToStream(stream); }
        const auto controlsFile = outputDirectory.getChildFile("Reverb-Legacy-controls.ospreset");
        auto* controlsRequestObject = new juce::DynamicObject();
        controlsRequestObject->setProperty("pluginName", pluginName); controlsRequestObject->setProperty("path", controlsFile.getFullPathName());
        controlsRequestObject->setProperty("fullState", oldControlsBytes.toBase64Encoding()); controlsRequestObject->setProperty("overwrite", true);
        const juce::var controlsRequest(controlsRequestObject);
        const auto controlsExport = eqPresetLibrary("export", controlsRequest);
        const auto controlsImport = eqPresetLibrary("import", controlsRequest);
        controlMigration = static_cast<bool>(controlsExport["success"]) && static_cast<bool>(controlsImport["success"])
            && setBuiltInPluginParam(factoryTrackId, "track", 0, "reverbControlMode", 1)
            && setBuiltInPluginState(factoryTrackId, "track", 0, juce::JSON::toString(controlsImport["state"]))
            && factoryReverb->reverbControlMode.load() == 0 && controlMigration;
        addCheck("reverb_control_behavior_migration", controlMigration,
            "Project/Compare full state retains the control behavior; missing fields in portable presets load Legacy, while factory reset uses Corrected.");
        bool optInMigration = factoryReverb != nullptr
            && setBuiltInPluginParam(factoryTrackId, "track", 0, "shimmerScheduling", 1)
            && setBuiltInPluginParam(factoryTrackId, "track", 0, "ambBody", .63f);
        const auto optInState = getBuiltInPluginState(factoryTrackId, "track", 0);
        optInMigration = setBuiltInPluginState(factoryTrackId, "track", 0, "{\"factoryDefault\":true}")
            && factoryReverb != nullptr && factoryReverb->shimmerScheduling.load() == 0
            && factoryReverb->ambBody.load() == 0 && optInMigration;
        optInMigration = setBuiltInPluginState(factoryTrackId, "track", 0, juce::JSON::toString(optInState))
            && factoryReverb != nullptr && factoryReverb->shimmerScheduling.load() == 1
            && factoryReverb->ambBody.load() == .63f && optInMigration;
        juce::MemoryBlock optInBytes;
        optInMigration = optInBytes.fromBase64Encoding(optInState["fullState"].toString()) && optInMigration;
        auto* optInRequestObject = new juce::DynamicObject();
        optInRequestObject->setProperty("pluginName", pluginName);
        optInRequestObject->setProperty("path", outputDirectory.getChildFile("Reverb-Spread-body-state.ospreset").getFullPathName());
        optInRequestObject->setProperty("fullState", optInBytes.toBase64Encoding()); optInRequestObject->setProperty("overwrite", true);
        const juce::var optInRequest(optInRequestObject);
        const auto optInExport = eqPresetLibrary("export", optInRequest);
        const auto optInImport = eqPresetLibrary("import", optInRequest);
        optInMigration = static_cast<bool>(optInExport["success"]) && static_cast<bool>(optInImport["success"])
            && setBuiltInPluginState(factoryTrackId, "track", 0, juce::JSON::toString(optInImport["state"]))
            && factoryReverb != nullptr && factoryReverb->shimmerScheduling.load() == 1
            && factoryReverb->ambBody.load() == .63f && optInMigration;
        auto preOptInTree = juce::ValueTree::readFromData(optInBytes.getData(), optInBytes.getSize());
        preOptInTree.removeProperty("shimmerScheduling", nullptr); preOptInTree.removeProperty("ambBody", nullptr);
        juce::MemoryBlock preOptInBytes;
        { juce::MemoryOutputStream stream(preOptInBytes, false); preOptInTree.writeToStream(stream); }
        auto* preOptInObject = new juce::DynamicObject();
        preOptInObject->setProperty("name", pluginName); preOptInObject->setProperty("fullState", preOptInBytes.toBase64Encoding());
        optInMigration = setBuiltInPluginState(factoryTrackId, "track", 0, juce::JSON::toString(juce::var(preOptInObject)))
            && factoryReverb != nullptr && factoryReverb->shimmerScheduling.load() == 0
            && factoryReverb->ambBody.load() == 0 && optInMigration;
        addCheck("reverb_spread_body_state_migration", optInMigration,
            "Spread scheduling and Vowel broadband body round-trip through complete host/project and portable state; reset and missing historical fields restore Original/zero.");
        const bool factoryTrackRemoved = factoryTrackId.isNotEmpty() && removeTrack(factoryTrackId);
        addCheck("reverb_refinement_state_migration", refinementMigration,
            "Refined round-trips in host state; factory reset and old portable state without the new property restore Original.");
        addCheck("reverb_factory_library_list", listed,
            "Eight stable voices, 41 type-specific authored voices and one collection appear in the preset API; existing same-name disk presets retain priority.");
        addCheck("reverb_factory_library_data", data,
            "Generated voices provide complete portable native state, including output trim.");
        addCheck("reverb_factory_library_recall", recall,
            "Native factory recall preserves full state and the existing six-field Mix Lock; output trim follows the selected voice.");
        addCheck("reverb_factory_library_copy", copies,
            "Factory voices duplicate into independent user preset files with identical state and descriptive metadata, without live recall.");
        addCheck("reverb_factory_library_immutable", protectedEntries && factoryTrackRemoved,
            "Generated entries reject overwrite, replacement and deletion; regression-created user copies and the temporary track are removed. Tested "
                + juce::String(generatedCount) + " generated entries; same-name disk entries are left untouched.");
        addCheck("reverb_factory_collection_browse", collectionBrowse,
            "Collection recall stores all 41 authored banks; native selector browsing and returning to Room preserves the complete state.");
        addCheck("reverb_factory_existing_disk_priority", diskPriority,
            "An isolated historical disk preset with the collection's display name wins listing, data and recall; real user directories remain untouched.");
    }
