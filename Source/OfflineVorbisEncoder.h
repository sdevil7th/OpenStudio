#pragma once

#include <JuceHeader.h>
#include <functional>

// Offline export only. The caller owns atomic publication of this staged file.
// Use JUCE's bundled libvorbis rather than requiring an optional FFmpeg encoder.
inline bool encodeOfflineVorbis(const juce::File& input, const juce::File& stagedOutput,
                                int quality, const std::function<bool()>& keepRunning)
{
    if ((keepRunning && !keepRunning()) || stagedOutput.exists()) return false;
    juce::WavAudioFormat wav;
    auto inputStream = input.createInputStream();
    if (!inputStream) return false;
    std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(inputStream.release(), true));
    if (!reader || reader->lengthInSamples <= 0 || reader->numChannels < 1 || reader->numChannels > 2)
        return false;
    // JUCE's Vorbis codec buffers its final packet until destruction and does
    // not propagate every OutputStream write failure. Observe the file status
    // through that final flush before allowing publication.
    struct CheckedStream final : juce::OutputStream
    {
        CheckedStream(std::unique_ptr<juce::FileOutputStream> fileIn, bool& successIn)
            : file(std::move(fileIn)), success(successIn) {}
        ~CheckedStream() override { flush(); }
        bool write(const void* data, size_t size) override
        {
            const bool written = file->write(data, size);
            success = success && written;
            return written;
        }
        void flush() override { file->flush(); success = success && file->getStatus().wasOk(); }
        juce::int64 getPosition() override { return file->getPosition(); }
        bool setPosition(juce::int64 position) override
        {
            const bool positioned = file->setPosition(position);
            success = success && positioned;
            return positioned;
        }
        std::unique_ptr<juce::FileOutputStream> file;
        bool& success;
    };
    auto file = stagedOutput.createOutputStream();
    if (!file) return false;
    bool ioSucceeded = true;
    juce::OggVorbisAudioFormat vorbis;
    std::unique_ptr<juce::OutputStream> stream = std::make_unique<CheckedStream>(std::move(file), ioSucceeded);
    auto writer = vorbis.createWriterFor(stream, juce::AudioFormatWriterOptions()
        .withSampleRate(reader->sampleRate).withNumChannels(static_cast<int>(reader->numChannels))
        .withBitsPerSample(24).withQualityOptionIndex(juce::jlimit(0, 10, quality)));
    if (!writer) return false;
    juce::AudioBuffer<float> block(static_cast<int>(reader->numChannels), 4096);
    for (juce::int64 offset = 0; offset < reader->lengthInSamples; offset += block.getNumSamples())
    {
        const int count = static_cast<int>(juce::jmin(juce::int64{4096}, reader->lengthInSamples - offset));
        if ((keepRunning && !keepRunning())
            || !reader->read(&block, 0, count, offset, true, reader->numChannels > 1)
            || !writer->writeFromAudioSampleBuffer(block, 0, count))
            return false;
    }
    // The destructor emits the final Vorbis packets. Check the completed stream
    // before the caller may replace an existing export, including write failures
    // that the codec's buffered write API cannot report until finalisation.
    writer.reset();
    if (!ioSucceeded || (keepRunning && !keepRunning())) return false;
    auto encodedStream = stagedOutput.createInputStream();
    if (!encodedStream) return false;
    std::unique_ptr<juce::AudioFormatReader> verified(vorbis.createReaderFor(encodedStream.release(), true));
    return verified && verified->lengthInSamples == reader->lengthInSamples
        && verified->numChannels == reader->numChannels && verified->sampleRate == reader->sampleRate;
}
