#pragma once
#include <JuceHeader.h>
#include <functional>

namespace AudioXRunTelemetry
{
struct Snapshot
{
    int combined = 0;
    int driver = -1;
    int host = -1;
    bool driverSupported = false;
    bool splitConsistent = false;
};

// AudioDeviceManager combines max(0, driver xruns) with its load-measurer
// deadline count. Derive the host part only while the driver's count/identity
// stayed stable across that combined read; never label a racing split exact.
inline Snapshot derive(int driverBefore, int combined, int driverAfter, bool sameDevice = true) noexcept
{
    Snapshot snapshot;
    snapshot.combined = combined;
    snapshot.driver = driverAfter;
    snapshot.driverSupported = driverAfter >= 0;
    snapshot.splitConsistent = sameDevice && driverBefore == driverAfter && combined >= 0
        && (!snapshot.driverSupported || combined >= driverAfter);
    if (snapshot.splitConsistent)
        snapshot.host = combined - (snapshot.driverSupported ? driverAfter : 0);
    return snapshot;
}

// Message/control-thread only, like the surrounding telemetry getters. Device
// lifetime is controlled there. Two bounded reads, no retry or callback lock.
inline Snapshot capture(const juce::AudioDeviceManager& manager)
{
    const auto* beforeDevice = manager.getCurrentAudioDevice();
    const int before = beforeDevice != nullptr ? beforeDevice->getXRunCount() : -1;
    const int combined = manager.getXRunCount();
    const auto* afterDevice = manager.getCurrentAudioDevice();
    const int after = afterDevice != nullptr ? afterDevice->getXRunCount() : -1;
    return derive(before, combined, after, beforeDevice == afterDevice);
}

inline void publish(juce::DynamicObject& object, const Snapshot& snapshot)
{
    // Preserve the shipped combined field and its original support flag.
    object.setProperty("audioDeviceXRunCount", snapshot.combined);
    object.setProperty("audioDeviceXRunTelemetrySupported", snapshot.combined >= 0);
    object.setProperty("audioDriverXRunCount", snapshot.driver);
    object.setProperty("audioDriverXRunTelemetrySupported", snapshot.driverSupported);
    object.setProperty("audioHostXRunCount", snapshot.host);
    object.setProperty("audioXRunSplitSnapshotConsistent", snapshot.splitConsistent);
}

inline void runRegression(const std::function<void(const char*, bool)>& check)
{
    const auto unknown = derive(-1, 17, -1);
    check("xrun_split_unknown_driver_retains_exact_host_count", !unknown.driverSupported
        && unknown.driver == -1 && unknown.combined == 17 && unknown.host == 17 && unknown.splitConsistent);
    const auto zero = derive(0, 0, 0);
    check("xrun_split_zero_supported", zero.driverSupported && zero.driver == 0 && zero.host == 0 && zero.splitConsistent);
    const auto stable = derive(105, 5642, 105);
    check("xrun_split_stable_driver_and_host_counts", stable.driver == 105 && stable.combined == 5642
        && stable.host == 5537 && stable.driverSupported && stable.splitConsistent);
    const auto changed = derive(105, 5642, 106);
    const auto changedSupport = derive(-1, 17, 0);
    const auto changedDevice = derive(0, 17, 0, false);
    check("xrun_split_races_withhold_host_decomposition", changed.host == -1 && !changed.splitConsistent
        && changed.driver == 106 && changed.driverSupported && changedSupport.host == -1
        && !changedSupport.splitConsistent && changedDevice.host == -1 && !changedDevice.splitConsistent);
    const auto inconsistent = derive(105, 100, 105);
    const auto invalidCombined = derive(-1, -1, -1);
    check("xrun_split_inconsistent_counters_are_not_precise", inconsistent.host == -1 && !inconsistent.splitConsistent
        && invalidCombined.host == -1 && !invalidCombined.splitConsistent);
    juce::DynamicObject serialized; publish(serialized, stable);
    check("xrun_split_preserves_legacy_combined_field", static_cast<int>(serialized.getProperty("audioDeviceXRunCount")) == 5642
        && static_cast<int>(serialized.getProperty("audioDriverXRunCount")) == 105
        && static_cast<int>(serialized.getProperty("audioHostXRunCount")) == 5537
        && static_cast<bool>(serialized.getProperty("audioXRunSplitSnapshotConsistent")));
}
}
