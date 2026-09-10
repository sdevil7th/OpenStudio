#pragma once
#include <JuceHeader.h>

// Called on the message thread only, when the user starts a take. MIDI takes
// also need this directory when they are finalized. Never relocate user media.
inline juce::Result prepareRecordingDirectory(const juce::File& directory)
{
    const auto created = directory.createDirectory();
    if (created.failed()) return created;
    juce::TemporaryFile probe(directory.getChildFile("openstudio-record-check"), juce::TemporaryFile::useHiddenFile);
    auto output = probe.getFile().createOutputStream();
    if (!output || !output->writeByte(0))
        return juce::Result::fail("Cannot write recordings to " + directory.getFullPathName());
    output->flush();
    const auto result = output->getStatus();
    output.reset();
    return result;
}
