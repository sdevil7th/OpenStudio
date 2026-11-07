#include "AudioEngine.h"
#include "ClipSourceDescriptor.h"
#include <cmath>

juce::var AudioEngine::getClipTempoPreviewData(const juce::String& trackId, const juce::String& clipId,
                                              double rangeStartSeconds, double durationSeconds, const juce::var& source) const
{
    auto* result = new juce::DynamicObject();
    const auto fail = [&](const juce::String& error) { result->setProperty("error", error); return juce::var(result); };
    if (!std::isfinite(rangeStartSeconds) || !std::isfinite(durationSeconds) || durationSeconds <= 0)
        return fail("The preview range is invalid");
    const auto snapshot = resolveReadOnlyClipSource(playbackEngine, trackId, clipId, source);
    if (snapshot)
    {
        const auto& clip = *snapshot;
        juce::AudioFormatManager formats; formats.registerBasicFormats();
        std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(clip.audioFile));
        if (!reader || !std::isfinite(reader->sampleRate) || reader->sampleRate < 8000 || reader->sampleRate > 384000)
            return fail("The preview source is unavailable");
        const double rate = reader->sampleRate;
        const int channels = juce::jlimit(1, 2, static_cast<int>(reader->numChannels));
        const double start = juce::jlimit(0.0, clip.duration, rangeStartSeconds);
        // At most 384000 stereo frames (~4 MiB encoded), independent of rate.
        const double seconds = juce::jmin(8.0, durationSeconds, clip.duration - start, 384000.0 / rate);
        const int samples = static_cast<int>(std::floor(seconds * rate));
        if (samples < 1) return fail("The selected preview range has no audio");
        reader.reset();
        PlaybackEngine preview; preview.setOfflineSourceReads(true); preview.addClipFromSnapshot(clip);
        auto memory = std::make_unique<juce::MemoryOutputStream>(); auto* bytes = memory.get();
        std::unique_ptr<juce::OutputStream> stream = std::move(memory);
        juce::WavAudioFormat format;
        auto writer = format.createWriterFor(stream, juce::AudioFormatWriterOptions().withSampleRate(rate)
            .withNumChannels(channels).withBitsPerSample(32).withSampleFormat(juce::AudioFormatWriterOptions::SampleFormat::floatingPoint));
        if (!writer) return fail("The preview buffer could not be prepared");
        juce::AudioBuffer<float> block(channels, 1024);
        for (int rendered = 0; rendered < samples; rendered += 1024)
        {
            const int count = juce::jmin(1024, samples - rendered); block.clear();
            preview.fillTrackBuffer(trackId, block, clip.startTime + start + rendered / rate, count, rate);
            if (preview.hasOfflineSourceReadFailure() || !writer->writeFromAudioSampleBuffer(block, 0, count))
                return fail("The source preview could not be read");
        }
        if (!writer->flush()) return fail("The preview buffer could not be finalized");
        result->setProperty("wavBase64", juce::Base64::toBase64(bytes->getData(), bytes->getDataSize()));
        result->setProperty("sampleRate", rate); result->setProperty("numChannels", channels);
        result->setProperty("durationSeconds", samples / rate); result->setProperty("rangeStartSeconds", start);
        result->setProperty("filePath", clip.audioFile.getFullPathName());
        result->setProperty("sourceOffsetSeconds", clip.offset); result->setProperty("clipDurationSeconds", clip.duration);
        return juce::var(result);
    }
    return fail("The selected clip is no longer available");
}
