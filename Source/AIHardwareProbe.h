#pragma once
#include "OwnedChildProcess.h"

namespace OpenStudioAI
{
// A failed command may print the GPU name in its error. Only successful stdout
// is hardware evidence. Use argv directly, never a quoted shell command string.
inline bool readCommandOutput(const juce::StringArray& arguments, juce::String& output,
                              const juce::StringPairArray& environment = {}, double timeoutMs = 8000.0)
{
    OwnedChildProcess process;
    if (!process.start(arguments, 1, environment)) return false;
    output.clear();
    const auto deadline = juce::Time::getMillisecondCounterHiRes() + timeoutMs;
    for (;;)
    {
        const bool running = process.isRunning();
        char buffer[4096];
        for (int block = 0; block < 16; ++block)
        {
            const int count = process.readProcessOutput(buffer, sizeof(buffer));
            if (count <= 0) break;
            output += juce::String::fromUTF8(buffer, count);
            if (output.length() > 1024 * 1024) return false;
        }
        if (!running) return process.getExitCode() == 0;
        if (juce::Time::getMillisecondCounterHiRes() >= deadline) return false;
        juce::Thread::sleep(10);
    }
}

inline bool commandOutputContains(const juce::StringArray& arguments, const juce::String& needle)
{
    juce::String output;
    return readCommandOutput(arguments, output) && output.containsIgnoreCase(needle);
}

// Scope ROCm library discovery to AI children; never alter the app's graphics
// loader or the user's system environment. AMD's standard SDK lives here.
inline juce::StringPairArray runtimeEnvironment()
{
    juce::StringPairArray environment;
   #if JUCE_LINUX
    const juce::File rocmLib("/opt/rocm/lib");
    if (rocmLib.getChildFile("libamdhip64.so").existsAsFile())
    {
        const auto existing = juce::SystemStats::getEnvironmentVariable("LD_LIBRARY_PATH", {});
        environment.set("LD_LIBRARY_PATH", rocmLib.getFullPathName() + (existing.isEmpty() ? "" : ":" + existing));
    }
   #endif
    return environment;
}

// ROCm exposes unified GPU memory as an allocatable GLOBAL pool. Do not use
// CPU pools, sum aliased pools, or confuse display carveout VRAM with this pool.
inline juce::int64 rocmGpuPoolMemoryMb(const juce::String& output)
{
    bool gpu = false, global = false;
    juce::int64 poolKb = 0, largestKb = 0;
    for (const auto& raw : juce::StringArray::fromLines(output))
    {
        const auto line = raw.trim();
        if (line.startsWith("Agent ")) { gpu = false; global = false; poolKb = 0; }
        if (line.startsWith("Device Type:")) gpu = line.fromFirstOccurrenceOf(":", false, false).trim() == "GPU";
        if (line.startsWith("Segment:")) { global = line.contains("GLOBAL;"); poolKb = 0; }
        if (line.startsWith("Size:") && line.endsWith(" KB"))
            poolKb = line.fromFirstOccurrenceOf(":", false, false).trim().getLargeIntValue();
        if (line.startsWith("Allocatable:") && line.endsWith("TRUE") && gpu && global)
            largestKb = juce::jmax(largestKb, poolKb);
    }
    return largestKb / 1024;
}
}
