#include "AudioFileConversion.h"
#include "FFmpegLocator.h"
#include "OwnedChildProcess.h"
#include <cmath>

juce::Result AudioFileConversion::convert(const juce::File& source, const juce::File& destination,
                                         const Options& options, const std::function<bool()>& keepRunning)
{
    const auto cancelled = [&] { return keepRunning && !keepRunning(); };
    if (cancelled()) return juce::Result::fail("Conversion cancelled");
    if (!source.existsAsFile() || !destination.getParentDirectory().isDirectory() || destination.isDirectory())
        return juce::Result::fail("Invalid source or destination");
    const auto executable = OpenStudioFFmpeg::findExecutable();
    if (!executable.existsAsFile()) return juce::Result::fail("The bundled FFmpeg runtime is unavailable");

    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(source));
    if (!reader || !std::isfinite(reader->sampleRate) || reader->sampleRate < 8000 || reader->sampleRate > 384000
        || reader->numChannels == 0 || reader->numChannels > 64 || reader->lengthInSamples <= 0)
        return juce::Result::fail("Unsupported or empty source audio");
    const auto sourceRate = reader->sampleRate;
    const auto sourceLength = reader->lengthInSamples;
    const int sourceChannels = static_cast<int>(reader->numChannels);
    const int rate = options.sampleRate == 0 ? juce::roundToInt(sourceRate) : options.sampleRate;
    const int channels = options.channels == 0 ? sourceChannels : options.channels;
    const int bits = options.bitDepth == 0 ? static_cast<int>(reader->bitsPerSample) : options.bitDepth;
    if (rate < 8000 || rate > 384000 || channels < 1 || channels > 64
        || (bits != 16 && bits != 24 && bits != 32) || options.timeoutMs <= 0
        || (options.format != "wav" && options.format != "aiff" && options.format != "flac")
        || (options.format == "flac" && bits == 32))
        return juce::Result::fail("Unsupported output settings (FLAC supports 16 or 24 bit)");
    // Downmixing a surround layout without explicit speaker weights is ambiguous.
    // Preserve multichannel files, but limit channel conversion to mono/stereo.
    if (channels != sourceChannels && (channels > 2 || sourceChannels > 2))
        return juce::Result::fail("Channel conversion supports mono and stereo only");
    const auto expectedLengthDouble = static_cast<double>(sourceLength) * rate / sourceRate;
    if (!std::isfinite(expectedLengthDouble) || expectedLengthDouble > 1.0e12)
        return juce::Result::fail("Source duration exceeds the conversion limit");
    const auto expectedLength = static_cast<juce::int64>(std::llround(expectedLengthDouble));
    if (expectedLength < 1) return juce::Result::fail("Source is shorter than one output sample");
    reader.reset(); // Allow explicit in-place conversion, but only publish after success.

    juce::TemporaryFile staged(destination, juce::TemporaryFile::useHiddenFile);
    juce::String codec;
    if (options.format == "flac") codec = "flac";
    else if (options.format == "wav") codec = bits == 32 ? "pcm_f32le" : "pcm_s" + juce::String(bits) + "le";
    else codec = bits == 32 ? "pcm_f32be" : "pcm_s" + juce::String(bits) + "be";
    juce::String filter;
    if (sourceChannels == 2 && channels == 1) filter = "pan=mono|c0=0.5*c0+0.5*c1,";
    if (sourceChannels == 1 && channels == 2) filter = "pan=stereo|c0=c0|c1=c0,";
    // Supply the filter's zero tail explicitly, including for files shorter than
    // one filter window, then trim to the duration-derived sample count.
    filter += "apad=pad_len=4096,aresample=" + juce::String(rate)
        + ":resampler=swr:filter_size=64:phase_shift=10:cutoff=0.97,atrim=end_sample=" + juce::String(expectedLength);
    juce::StringArray arguments { executable.getFullPathName(), "-hide_banner", "-nostdin", "-v", "error",
        "-xerror", "-y", "-threads", "1", "-i", source.getFullPathName(), "-map", "0:a:0", "-vn", "-sn", "-dn",
        "-map_metadata", "-1", "-filter_threads", "1", "-af", filter, "-ac", juce::String(channels),
        "-ar", juce::String(rate), "-c:a", codec, "-threads", "1" };
    if (options.format == "flac")
    {
        arguments.addArray({ "-sample_fmt", bits == 16 ? "s16" : "s32", "-bits_per_raw_sample", juce::String(bits) });
    }
    if (options.format == "wav") arguments.addArray({ "-rf64", "auto" });
    arguments.addArray({ "-f", options.format, staged.getFile().getFullPathName() });
    OwnedChildProcess process;
    if (cancelled() || !process.start(arguments)) return juce::Result::fail("Could not start audio conversion");
    const auto started = juce::Time::getMillisecondCounterHiRes();
    juce::MemoryOutputStream diagnostic;
    bool interrupted = false;
    while (process.isRunning())
    {
        if (cancelled() || juce::Time::getMillisecondCounterHiRes() - started >= options.timeoutMs)
        {
            interrupted = true;
            process.kill();
            break;
        }
        char bytes[4096];
        for (int block = 0; block < 4; ++block)
        {
            const auto count = process.readProcessOutput(bytes, sizeof(bytes));
            if (count <= 0) break;
            if (diagnostic.getDataSize() < 65536) diagnostic.write(bytes, static_cast<size_t>(count));
        }
        juce::Thread::sleep(10);
    }
    // A terminated process must relinquish the staged file before cleanup.
    const std::atomic<bool> waitForExit { true };
    if (!process.waitForProcessToFinish(2000, waitForExit) || interrupted || cancelled())
        return juce::Result::fail("Conversion cancelled or timed out; original files were preserved");
    if (process.getExitCode() != 0)
        return juce::Result::fail("Audio conversion failed: " + diagnostic.toString().substring(0, 2048));

    std::unique_ptr<juce::AudioFormatReader> converted(formats.createReaderFor(staged.getFile()));
    if (!converted || converted->sampleRate != rate || static_cast<int>(converted->numChannels) != channels
        || std::abs(converted->lengthInSamples - expectedLength) > 1)
        return juce::Result::fail("Converted audio failed duration/format validation; original files were preserved");
    converted.reset();
    // Observe the OS flush result before publishing. FFmpeg has closed/finalized it.
    auto publicationStream = staged.getFile().createOutputStream();
    if (!publicationStream) return juce::Result::fail("Could not verify the converted file");
    publicationStream->flush();
    const bool flushed = publicationStream->getStatus().wasOk();
    publicationStream.reset();
    if (!flushed || cancelled() || !staged.overwriteTargetFileWithTemporary())
        return juce::Result::fail("Could not publish converted audio; the original destination was preserved");
    return juce::Result::ok();
}
