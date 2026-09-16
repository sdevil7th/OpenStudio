#pragma once

#include <JuceHeader.h>

namespace OpenStudioCrashDiagnostics
{
    enum class RealtimeFault { recordingLockMiss, recordingOverflow, namSafetyTrip,
        trackBufferContract, pluginBufferContract, recordingBufferContract,
        processorException, processorNonFinite, processorRemote, count };
    void recordRealtimeFault(RealtimeFault fault) noexcept;
    void flushRealtimeFaults(); // Message thread, rate-limited, disk writes only after a failure.
    void installCrashHandlers();
    void pulseMessageThread() noexcept; // One atomic timestamp; never writes to disk.
    // Only after the user committed to quitting. No thread termination; the
    // external reporter bounds the entire already-quitting process lifetime.
    void beginFinalShutdown();
    void recordBreadcrumb(const juce::String& stage, const juce::String& detail = {});
    juce::File getBreadcrumbLogFile();
    juce::File getLastCrashDumpFile();
    int runSelfTest(const juce::File& isolatedDirectory, bool simulateCrash, bool simulateDumpFailure = false,
                    bool simulateReporterUnavailable = false, bool simulateHang = false,
                    bool simulateShutdownHang = false);
}
