#pragma once

#include <JuceHeader.h>

// Update maintenance is restricted to a previously installed managed stem
// runtime. It never opts a new user into AI setup or changes a per-job device.
namespace AIRuntimeMaintenance
{
inline bool writeDocument(const juce::File& destination, const juce::var& value)
{
    if (! destination.getParentDirectory().createDirectory()) return false;
    juce::TemporaryFile temporary(destination);
    return temporary.getFile().replaceWithText(juce::JSON::toString(value, true))
        && temporary.overwriteTargetFileWithTemporary();
}

inline juce::var readDocument(const juce::File& file)
{
    return file.existsAsFile() && file.getSize() <= 16384 ? juce::JSON::parse(file) : juce::var();
}

enum class Claim { started, busy, previousAttempt, writeFailed };

inline Claim claim(const juce::File& file, const juce::var& receipt, bool explicitRetry = false)
{
    const auto path = file.getFullPathName();
    juce::InterProcessLock gate("OpenStudio-AI-update-" + juce::SHA256(path.toRawUTF8(), path.getNumBytesAsUTF8()).toHexString());
    if (! gate.enter(0)) return Claim::busy;
    struct Release { juce::InterProcessLock& lock; ~Release() { lock.exit(); } } release { gate };
    const auto previous = readDocument(file);
    if (!explicitRetry && previous.getProperty("contractKey", "").toString() == receipt.getProperty("contractKey", "").toString())
    {
        const auto state = previous.getProperty("state", "").toString();
        if (state == "attempting" || state == "failed" || state == "cancelled") return Claim::previousAttempt;
    }
    return writeDocument(file, receipt) ? Claim::started : Claim::writeFailed;
}

inline juce::var evaluate(const juce::var& context, const juce::var& probe,
                          const juce::var& plan, const juce::var& previous)
{
    auto result = std::make_unique<juce::DynamicObject>();
    const auto backend = context.getProperty("expectedBackend", "cpu").toString();
    const auto identity = context.getProperty("appVersion", "").toString() + "|" + backend + "|"
        + context.getProperty("gpuName", "").toString() + "|" + juce::JSON::toString(plan, true);
    const auto key = juce::SHA256(identity.toRawUTF8(), identity.getNumBytesAsUTF8()).toHexString();
    result->setProperty("contractKey", key);
    result->setProperty("expectedBackend", backend);
    result->setProperty("automatic", true);
    auto finish = [&] (const juce::String& state, const juce::String& reason)
    {
        result->setProperty("state", state);
        result->setProperty("message", reason);
        return juce::var(result.release());
    };
    if (! static_cast<bool>(context.getProperty("managedRuntimePresent", false))
        || ! static_cast<bool>(context.getProperty("stemModelInstalled", false)))
        return finish("not_installed", "Automatic updates apply to installed AI tools.");
    if (static_cast<bool>(context.getProperty("explicitCpuOnly", false)))
        return finish("cpu_only", "Keeping your CPU-only setup choice.");
    if (! plan.isObject())
        return finish("unavailable", "No reviewed runtime update is available for this platform.");

    bool compatible = static_cast<bool>(probe.getProperty("runtimeReady", false));
    compatible = compatible && probe.getProperty("selectedBackend", "").toString() == backend;
    juce::StringPairArray fields;
    fields.set("torch", "torchVersion");
    fields.set("torchvision", "torchvisionVersion");
    fields.set("torchaudio", "torchaudioVersion");
    fields.set("audio-separator", "audioSeparatorVersion");
    if (const auto* steps = plan.getProperty("steps", {}).getArray())
        for (const auto& step : *steps)
        {
            if (step.getProperty("type", "").toString() != "pip_install") continue;
            const auto features = step.getProperty("features", {});
            if (features.isArray() && ! features.getArray()->contains(juce::var("stemSeparation"))) continue;
            if (const auto* packages = step.getProperty("packages", {}).getArray())
                for (const auto& package : *packages)
                {
                    const auto requirement = package.toString();
                    if (! requirement.contains("==")) continue;
                    const auto name = requirement.upToFirstOccurrenceOf("==", false, false)
                        .upToFirstOccurrenceOf("[", false, false);
                    if (! fields.containsKey(name)) continue;
                    const auto expected = requirement.fromFirstOccurrenceOf("==", false, false)
                        .upToFirstOccurrenceOf("+", false, false);
                    const auto actual = probe.getProperty(juce::Identifier(fields[name]), "").toString()
                        .upToFirstOccurrenceOf("+", false, false);
                    compatible = compatible && expected == actual;
                }
        }
    if (compatible) return finish("current", "Installed AI tools match this app's runtime requirements.");
    if (previous.getProperty("contractKey", "").toString() == key)
    {
        const auto state = previous.getProperty("state", "").toString();
        if (state == "attempting" || state == "failed" || state == "cancelled")
            return finish(state == "attempting" ? "interrupted" : state,
                state == "attempting" ? "An automatic AI update already started in another window or was interrupted. This window will not start a duplicate update."
                    : "The automatic AI update did not complete. Your previous runtime was retained; AI Tools shows retry options.");
    }
    return finish("needed", backend == "cuda"
        ? "Updating installed AI tools to use your NVIDIA GPU."
        : "Updating installed AI tools for this version of OpenStudio.");
}

}
