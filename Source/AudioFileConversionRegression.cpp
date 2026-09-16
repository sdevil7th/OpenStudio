#include "AudioFileConversionRegression.h"
#include "AudioFileConversion.h"
#include "OwnedChildProcess.h"
#include <cmath>

namespace
{
bool writeFixture(const juce::File& path, int rate, int channels, int length, double frequency)
{
    juce::WavAudioFormat format;
    std::unique_ptr<juce::OutputStream> stream = path.createOutputStream();
    auto writer = format.createWriterFor(stream, juce::AudioFormatWriterOptions()
        .withSampleRate(rate).withNumChannels(channels).withBitsPerSample(24));
    if (!writer) return false;
    juce::AudioBuffer<float> samples(channels, length);
    for (int channel = 0; channel < channels; ++channel)
        for (int sample = 0; sample < length; ++sample)
            samples.setSample(channel, sample, static_cast<float>((channel == 0 ? 0.25 : -0.125)
                * std::sin(juce::MathConstants<double>::twoPi * frequency * sample / rate)));
    return writer->writeFromAudioSampleBuffer(samples, 0, length) && writer->flush();
}
std::unique_ptr<juce::AudioFormatReader> openFixture(const juce::File& file)
{
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    return std::unique_ptr<juce::AudioFormatReader>(formats.createReaderFor(file));
}
}

void runAudioFileConversionRegression(const juce::File& root, const std::function<void(const char*, bool)>& check)
{
   #if !JUCE_WINDOWS
    // Exercise the actual POSIX pipe on a quiet long-lived child; FFmpeg normally
    // writes no diagnostics on success. Neither the read nor timeout may wait for EOF.
    {
        OwnedChildProcess quiet;
        const bool started = quiet.start({ "/bin/sh", "-c", "sleep 30" });
        char bytes[4096];
        const auto before = juce::Time::getMillisecondCounterHiRes();
        const auto count = quiet.readProcessOutput(bytes, sizeof(bytes));
        check("posix_quiet_child_read_is_nonblocking", started && count == 0
            && juce::Time::getMillisecondCounterHiRes() - before < 100.0);
        std::atomic<bool> keepRunning { true };
        check("posix_quiet_child_timeout_terminates_group", !quiet.waitForProcessToFinish(50, keepRunning)
            && juce::Time::getMillisecondCounterHiRes() - before < 2000.0);
    }
    {
        OwnedChildProcess quiet;
        const bool started = quiet.start({ "/bin/sh", "-c", "sleep 30" });
        std::atomic<bool> keepRunning { false };
        const auto before = juce::Time::getMillisecondCounterHiRes();
        check("posix_quiet_child_cancellation_is_bounded", started && !quiet.waitForProcessToFinish(30000, keepRunning)
            && juce::Time::getMillisecondCounterHiRes() - before < 2000.0);
    }
   #endif
    const auto directory = root.getChildFile("conversion");
    directory.createDirectory();
    const auto alive = [] { return true; };
    AudioFileConversion::Options options;
    options.bitDepth = 24;
    bool ratesPass = true, pitchPass = true;
    for (const int sourceRate : { 44100, 48000, 96000 })
    {
        const auto source = directory.getChildFile("source-" + juce::String(sourceRate) + ".wav");
        ratesPass = writeFixture(source, sourceRate, 1, sourceRate / 5, 1000) && ratesPass;
        for (const int outputRate : { 44100, 48000, 96000 })
        {
            options.sampleRate = outputRate;
            const auto output = directory.getChildFile(juce::String(sourceRate) + "-" + juce::String(outputRate) + ".wav");
            const auto result = AudioFileConversion::convert(source, output, options, alive);
            auto reader = openFixture(output);
            ratesPass = result.wasOk() && reader && reader->sampleRate == outputRate
                && reader->lengthInSamples == outputRate / 5 && ratesPass;
            if (!reader) { pitchPass = false; continue; }
            juce::AudioBuffer<float> samples(1, static_cast<int>(reader->lengthInSamples));
            pitchPass = reader->read(&samples, 0, samples.getNumSamples(), 0, true, false) && pitchPass;
            double error = 0;
            for (int i = 256; i < samples.getNumSamples() - 256; ++i)
            {
                const auto expected = 0.25 * std::sin(juce::MathConstants<double>::twoPi * 1000 * i / outputRate);
                error = juce::jmax(error, std::abs(expected - samples.getSample(0, i)));
            }
            pitchPass = error < 0.0001 && pitchPass;
        }
    }
    check("converter_all_44100_48000_96000_rate_pairs_preserve_duration", ratesPass);
    check("converter_rate_changes_preserve_1khz_frequency_and_amplitude", pitchPass);
    const auto stereo = directory.getChildFile("stereo.wav");
    check("converter_stereo_fixture_written", writeFixture(stereo, 48000, 2, 9600, 1000));
    options.sampleRate = 48000;
    const auto same = directory.getChildFile("same.wav");
    bool parity = AudioFileConversion::convert(stereo, same, options, alive).wasOk();
    auto original = openFixture(stereo);
    auto copied = openFixture(same);
    if (original && copied)
    {
        juce::AudioBuffer<float> a(2, 9600), b(2, 9600);
        parity = original->read(&a, 0, 9600, 0, true, true) && copied->read(&b, 0, 9600, 0, true, true) && parity;
        for (int channel = 0; channel < 2; ++channel)
            for (int sample = 0; sample < 9600; ++sample)
                parity = a.getSample(channel, sample) == b.getSample(channel, sample) && parity;
    }
    else parity = false;
    check("converter_same_rate_same_depth_sample_parity", parity);
    options.channels = 1;
    const auto mono = directory.getChildFile("mono.wav");
    bool monoPass = AudioFileConversion::convert(stereo, mono, options, alive).wasOk();
    auto downmix = openFixture(mono);
    if (downmix)
    {
        juce::AudioBuffer<float> samples(1, 9600);
        monoPass = downmix->numChannels == 1 && downmix->read(&samples, 0, 9600, 0, true, false) && monoPass;
        for (int sample = 0; sample < 9600; ++sample)
            monoPass = std::abs(samples.getSample(0, sample) - 0.0625
                * std::sin(juce::MathConstants<double>::twoPi * 1000 * sample / 48000)) < 0.000001 && monoPass;
    }
    else monoPass = false;
    check("converter_stereo_to_mono_uses_explicit_average", monoPass);
    options.channels = 2;
    const auto duplicated = directory.getChildFile("duplicated.wav");
    bool stereoPass = AudioFileConversion::convert(mono, duplicated, options, alive).wasOk();
    auto upmix = openFixture(duplicated);
    if (upmix)
    {
        juce::AudioBuffer<float> samples(2, 9600);
        stereoPass = upmix->numChannels == 2 && upmix->read(&samples, 0, 9600, 0, true, true) && stereoPass;
        for (int sample = 0; sample < 9600; ++sample)
            stereoPass = samples.getSample(0, sample) == samples.getSample(1, sample) && stereoPass;
    }
    else stereoPass = false;
    check("converter_mono_to_stereo_duplicates_without_gain_change", stereoPass);
    options.channels = 0;
    const auto high = directory.getChildFile("above-nyquist.wav");
    writeFixture(high, 96000, 1, 19200, 30000);
    options.sampleRate = 44100;
    const auto filtered = directory.getChildFile("filtered.wav");
    bool aliasPass = AudioFileConversion::convert(high, filtered, options, alive).wasOk();
    auto filteredReader = openFixture(filtered);
    if (filteredReader)
    {
        juce::AudioBuffer<float> samples(1, 8820);
        aliasPass = filteredReader->read(&samples, 0, 8820, 0, true, false)
            && samples.getRMSLevel(0, 256, 8308) < 0.0001f && aliasPass;
    }
    else aliasPass = false;
    check("converter_downsampling_rejects_above_nyquist_signal", aliasPass);
    bool shortPass = true;
    for (const int length : { 1, 2, 17, 63 })
    {
        const auto source = directory.getChildFile("short-" + juce::String(length) + ".wav");
        const auto output = directory.getChildFile("short-out-" + juce::String(length) + ".wav");
        writeFixture(source, 48000, 1, length, 1000);
        shortPass = AudioFileConversion::convert(source, output, options, alive).wasOk() && shortPass;
        auto reader = openFixture(output);
        shortPass = reader && reader->lengthInSamples == std::llround(length * 44100.0 / 48000) && shortPass;
    }
    check("converter_sub_filter_window_files_have_exact_length", shortPass);
    bool formatsPass = true;
    for (const auto* format : { "wav", "aiff", "flac" })
    {
        options.format = format;
        const auto output = directory.getChildFile(juce::String("format.") + format);
        formatsPass = AudioFileConversion::convert(stereo, output, options, alive).wasOk() && formatsPass;
    }
    check("converter_wav_aiff_flac_are_finalized_and_readable", formatsPass);
    options.format = "wav";
    const auto protectedOutput = directory.getChildFile("preserve.wav");
    protectedOutput.replaceWithText("existing destination");
    check("converter_pre_cancel_preserves_existing_destination",
        AudioFileConversion::convert(stereo, protectedOutput, options, [] { return false; }).failed()
        && protectedOutput.loadFileAsString() == "existing destination");
    int cancellationChecks = 0;
    check("converter_running_child_cancel_preserves_existing_destination",
        AudioFileConversion::convert(stereo, protectedOutput, options, [&] { return ++cancellationChecks < 3; }).failed()
        && protectedOutput.loadFileAsString() == "existing destination");
    options.timeoutMs = 1;
    check("converter_timeout_preserves_existing_destination",
        AudioFileConversion::convert(stereo, protectedOutput, options, alive).failed()
        && protectedOutput.loadFileAsString() == "existing destination");
    options.timeoutMs = 30000;
    options.sampleRate = -1;
    check("converter_invalid_rate_rejected_before_publication",
        AudioFileConversion::convert(stereo, protectedOutput, options, alive).failed()
        && protectedOutput.loadFileAsString() == "existing destination");
    options.sampleRate = 48000;
    check("converter_unwritable_destination_is_reported",
        AudioFileConversion::convert(stereo, directory, options, alive).failed());
    check("converter_invalid_input_preserves_destination",
        AudioFileConversion::convert(protectedOutput, same, options, alive).failed() && openFixture(same) != nullptr);
}
