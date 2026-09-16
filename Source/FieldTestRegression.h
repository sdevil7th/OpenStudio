#pragma once
#include "AudioInputPolicy.h"
#include "PluginSettingsMigration.h"
#include "RecordingDestination.h"

inline void runFieldTestRegression(const juce::File& directory, const std::function<void(const char*, bool)>& check)
{
    juce::XmlElement desired("DEVICESETUP");
    desired.setAttribute("deviceType", "CoreAudio");
    desired.setAttribute("audioDeviceName", "Audient iD14");
    desired.setAttribute("audioDeviceInChans", "1111");
    desired.setAttribute("audioDeviceOutChans", "11");
    desired.setAttribute("audioDeviceRate", 48000);
    desired.setAttribute("audioDeviceBufferSize", 16);
    auto effective = desired;
    AudioInputPolicy::suppressInput(effective);
    check("permission_saved_mask_suppressed_before_open", effective.getStringAttribute("audioDeviceInChans") == "0"
        && effective.getStringAttribute("audioInputDeviceName").isEmpty() && !effective.hasAttribute("audioDeviceName"));
    check("permission_playback_device_preserved", effective.getStringAttribute("audioOutputDeviceName") == "Audient iD14"
        && effective.getIntAttribute("audioDeviceRate") == 48000 && effective.getIntAttribute("audioDeviceBufferSize") == 16);
    effective.setAttribute("audioDeviceBufferSize", 64);
    AudioInputPolicy::preserveInputPreference(effective, desired);
    check("permission_saved_preference_roundtrip", desired.getStringAttribute("audioDeviceInChans") == "1111"
        && effective.getStringAttribute("audioDeviceInChans") == "1111"
        && effective.getStringAttribute("audioInputDeviceName") == "Audient iD14"
        && effective.getIntAttribute("audioDeviceBufferSize") == 64);

    const auto source = directory.getChildFile("OpenStudio-previous");
    const auto destination = directory.getChildFile("PluginSettings");
    source.createDirectory();
    source.getChildFile("PluginList.xml").replaceWithText("<KNOWNPLUGINS/>\n");
    source.getChildFile("PluginBlacklist.txt").replaceWithText("unsafe-plugin\n");
    source.getChildFile("PluginSearchPaths.xml").replaceWithText("<PLUGIN_SEARCH_PATHS><PATH path='/custom/plugins'/></PLUGIN_SEARCH_PATHS>");
    source.getChildFile("PluginHosting.json").replaceWithText("[\"isolated-plugin\"]");
    source.getChildFile("PluginScanDeadMansPedal.txt").replaceWithText("interrupted-plugin\n");
    source.getChildFile("Audio").createDirectory();
    source.getChildFile("Audio/take.wav").replaceWithText("fixture-user-media");
    const auto migrated = migrateOpenStudioPluginSettings(source, destination);
    check("openstudio_plugin_settings_migrated", migrated.wasOk());
    check("openstudio_safety_state_preserved", destination.getChildFile("PluginBlacklist.txt").hasIdenticalContentTo(source.getChildFile("PluginBlacklist.txt"))
        && destination.getChildFile("PluginScanDeadMansPedal.txt").hasIdenticalContentTo(source.getChildFile("PluginScanDeadMansPedal.txt"))
        && destination.getChildFile("PluginHosting.json").loadFileAsString() == "[\"isolated-plugin\"]");
    check("openstudio_recordings_not_relocated", source.getChildFile("Audio/take.wav").existsAsFile() && !destination.getChildFile("Audio").exists());
    destination.getChildFile("PluginBlacklist.txt").replaceWithText("updated-policy\n");
    const auto updatedPolicy = destination.getChildFile("PluginBlacklist.txt").loadFileAsString();
    check("openstudio_migration_does_not_overwrite_new_policy", migrateOpenStudioPluginSettings(source, destination).wasOk()
        && destination.getChildFile("PluginBlacklist.txt").loadFileAsString() == updatedPolicy);
    source.getChildFile("PluginList.xml").replaceWithText("broken xml");
    const auto rejected = directory.getChildFile("RejectedSettings");
    check("openstudio_bad_migration_not_published", migrateOpenStudioPluginSettings(source, rejected).failed()
        && !rejected.exists() && source.getChildFile("PluginList.xml").loadFileAsString() == "broken xml");
    const auto fresh = directory.getChildFile("FreshSettings");
    check("openstudio_fresh_install_without_documents", migrateOpenStudioPluginSettings(directory.getChildFile("MissingDocuments"), fresh).wasOk()
        && fresh.getChildFile("settings-initialized").existsAsFile());
    const auto blocked = directory.getChildFile("BlockedParent");
    blocked.replaceWithText("file, not a folder");
    check("openstudio_unwritable_destination_fails", migrateOpenStudioPluginSettings(directory.getChildFile("MissingDocuments"), blocked.getChildFile("Settings")).failed());
    source.getChildFile("PluginList.xml").replaceWithText("<KNOWNPLUGINS/>");
    source.getChildFile("PluginHosting.json").replaceWithText("[42]");
    const auto invalidPolicy = directory.getChildFile("InvalidPolicy");
    check("openstudio_invalid_isolation_policy_not_published", migrateOpenStudioPluginSettings(source, invalidPolicy).failed() && !invalidPolicy.exists());
    source.getChildFile("PluginHosting.json").replaceWithText("[\"isolated-plugin\"]");
    source.getChildFile("PluginSearchPaths.xml").replaceWithText("<WRONG_SCHEMA/>");
    const auto invalidPaths = directory.getChildFile("InvalidPaths");
    check("openstudio_wrong_settings_schema_not_published", migrateOpenStudioPluginSettings(source, invalidPaths).failed() && !invalidPaths.exists());
    const auto recordingFolder = directory.getChildFile("RecordingDestination");
    check("recording_destination_writable_before_start", prepareRecordingDirectory(recordingFolder).wasOk()
        && recordingFolder.findChildFiles(juce::File::findFiles, false).isEmpty());
    check("recording_destination_denial_rejected", prepareRecordingDirectory(blocked.getChildFile("Audio")).failed()
        && blocked.loadFileAsString() == "file, not a folder");
}
