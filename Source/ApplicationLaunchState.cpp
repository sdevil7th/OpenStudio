#include "ApplicationLaunchState.h"

namespace
{
juce::CriticalSection& getLaunchStateLock()
{
    static juce::CriticalSection lock;
    return lock;
}

juce::String& getPendingProjectPathStorage()
{
    static juce::String pendingProjectPath;
    return pendingProjectPath;
}

bool isSupportedProjectPath(const juce::String& candidate)
{
    const auto trimmed = candidate.trim();
    if (trimmed.isEmpty())
        return false;

    const auto lower = trimmed.toLowerCase();
    return lower.endsWith(".osproj") || lower.endsWith(".s13");
}

void addCandidate(juce::StringArray& candidates, const juce::String& candidate)
{
    const auto normalized = candidate.trim().unquoted();
    if (normalized.isNotEmpty())
        candidates.addIfNotAlreadyThere(normalized);
}
}

juce::String OpenStudioLaunchState::normalisePendingProjectPath(const juce::String& commandLineOrPath)
{
    juce::StringArray candidates;
    const auto trimmed = commandLineOrPath.trim();

    addCandidate(candidates, trimmed);

    juce::StringArray tokens;
    tokens.addTokens(trimmed, " ", "\"");
    for (const auto& token : tokens)
        addCandidate(candidates, token);

    auto remaining = trimmed;
    while (remaining.containsChar('"'))
    {
        const auto firstQuote = remaining.indexOfChar('"');
        if (firstQuote < 0)
            break;

        remaining = remaining.substring(firstQuote + 1);
        const auto secondQuote = remaining.indexOfChar('"');
        if (secondQuote < 0)
            break;

        addCandidate(candidates, remaining.substring(0, secondQuote));
        remaining = remaining.substring(secondQuote + 1);
    }

    for (const auto& candidate : candidates)
    {
        if (!isSupportedProjectPath(candidate))
            continue;

        const juce::File file(candidate);
        if (file.existsAsFile())
            return file.getFullPathName();
    }

    for (const auto& candidate : candidates)
        if (isSupportedProjectPath(candidate))
            return candidate;

    return {};
}

void OpenStudioLaunchState::setPendingProjectPath(const juce::String& projectPath)
{
    const auto normalized = normalisePendingProjectPath(projectPath);
    if (normalized.isEmpty())
        return;

    const juce::ScopedLock lock(getLaunchStateLock());
    getPendingProjectPathStorage() = normalized;
}

juce::String OpenStudioLaunchState::consumePendingProjectPath()
{
    const juce::ScopedLock lock(getLaunchStateLock());
    auto result = getPendingProjectPathStorage();
    getPendingProjectPathStorage().clear();
    return result;
}
