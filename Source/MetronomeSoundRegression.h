#pragma once
#include "Metronome.h"
#include "MetronomeSounds.h"

template <typename Check>
void runMetronomeSoundRegression(const Check& check)
{
    const auto hit = [] (double rate, double lead, bool stereo = false)
    {
        juce::AudioBuffer<float> result(stereo ? 2 : 1, juce::roundToInt(rate * 0.3));
        result.clear();
        const int start = juce::roundToInt(rate * lead);
        const int length = juce::roundToInt(rate * 0.012);
        for (int sample = 0; sample < length; ++sample)
        {
            const float value = static_cast<float>(std::sin(juce::MathConstants<double>::pi * sample / length)
                * std::exp(-3.0 * sample / length));
            result.setSample(0, start + sample, value + 0.01f);
            if (stereo) result.setSample(1, start + sample, -value + 0.01f);
        }
        return result;
    };
    const auto peakIndex = [] (const juce::AudioBuffer<float>& audio)
    {
        int peak = 0;
        for (int sample = 1; sample < audio.getNumSamples(); ++sample)
            if (std::abs(audio.getSample(0, sample)) > std::abs(audio.getSample(0, peak))) peak = sample;
        return peak;
    };
    for (const double rate : { 8000.0, 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        const auto regular = MetronomeSounds::synthesise("builtin:cowbell", false, rate);
        const auto accent = MetronomeSounds::synthesise("builtin:cowbell", true, rate);
        const int count = regular.getNumSamples();
        bool finite = true, sameBell = true;
        for (int sample = 0; sample < count; ++sample)
        {
            finite = finite && std::isfinite(regular.getSample(0, sample)) && std::isfinite(accent.getSample(0, sample));
            sameBell = sameBell && std::abs(accent.getSample(0, sample) - 1.25f * regular.getSample(0, sample)) < 1.0e-6f;
        }
        check("cowbell_bounded_attack_tail_" + juce::String(rate), finite
            && count == juce::roundToInt(rate * 0.1)
            && std::abs(regular.getMagnitude(0, count) - 0.64f) < 1.0e-6f
            && std::abs(accent.getMagnitude(0, count) - 0.8f) < 1.0e-6f
            && regular.getSample(0, 0) == 0.0f && regular.getSample(0, count - 1) == 0.0f
            && std::abs(peakIndex(regular) - juce::roundToInt(rate * 0.001)) <= 1,
            "Cowbell remains finite, bounded and smoothly ended, with its attack peak at 1ms across device rates; timbre is not asserted.");
        check("cowbell_accent_same_pitch_and_timing_" + juce::String(rate), sameBell && peakIndex(regular) == peakIndex(accent),
            "Accent is 25% stronger with identical pitch and attack timing, rather than a transposed oscillator pair.");
    }
    for (const double rate : { 8000.0, 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        const auto regular = MetronomeSounds::prepare(hit(rate, 0.030), rate);
        const auto accent = MetronomeSounds::prepare(hit(rate, 0.170, true), rate);
        const bool valid = regular.error.isEmpty() && accent.error.isEmpty();
        check("custom_attack_alignment_" + juce::String(rate), valid
            && std::abs(peakIndex(regular.audio) - 48) <= 2 && std::abs(peakIndex(accent.audio) - 48) <= 2,
            "Different leading silence and opposite-polarity stereo place the first transient peak at 1ms (+/-2 prepared samples).");
        check("custom_headroom_tail_" + juce::String(rate), valid
            && regular.audio.getNumSamples() <= 4800 && accent.audio.getNumSamples() <= 4800
            && std::abs(regular.audio.getMagnitude(0, regular.audio.getNumSamples()) - 0.8f) < 1.0e-6f
            && accent.audio.getSample(0, accent.audio.getNumSamples() - 1) == 0.0f,
            "Prepared clicks have matched 0.8 peaks, at most 100ms duration and a zero-ending fade.");
    }
    {
        juce::AudioBuffer<float> edge(1, 64);
        for (int sample = 0; sample < 64; ++sample) edge.setSample(0, sample, sample < 32 ? 0.8f : -0.8f);
        const auto interpolated = MetronomeSounds::resample(edge, 48000, 192000);
        check("custom_resample_overshoot_headroom", interpolated.getMagnitude(0, interpolated.getNumSamples()) <= 0.800001f,
            "Sinc interpolation cannot turn a bounded prepared click into an above-headroom output.");
    }
    {
        juce::AudioBuffer<float> silence(1, 4800); silence.clear();
        check("custom_reject_silence", MetronomeSounds::prepare(silence, 48000).error.isNotEmpty(), "Silent files cannot replace the current click.");
        juce::FloatVectorOperations::fill(silence.getWritePointer(0), 0.3f, 4800);
        check("custom_reject_dc_only", MetronomeSounds::prepare(silence, 48000).error.isNotEmpty(), "DC-only audio is not a usable click.");
        silence.setSample(0, 1, std::numeric_limits<float>::quiet_NaN());
        check("custom_reject_nonfinite", MetronomeSounds::prepare(silence, 48000).error.isNotEmpty(), "NaN input is rejected before publication.");
        juce::FloatVectorOperations::fill(silence.getWritePointer(0), 1.0f, 4800);
        check("custom_reject_clipped", MetronomeSounds::prepare(silence, 48000).error.isNotEmpty(), "Clipped plateaus cannot be repaired by peak normalization and are rejected.");
        auto multiple = hit(48000, 0.030);
        auto second = hit(48000, 0.170);
        multiple.addFrom(0, 0, second, 0, 0, second.getNumSamples());
        check("custom_reject_multiple_hits", MetronomeSounds::prepare(multiple, 48000).error.isNotEmpty(), "Two transients separated by silence cannot create false extra beats.");
        juce::AudioBuffer<float> slow(1, 24000);
        for (int sample = 0; sample < slow.getNumSamples(); ++sample)
            slow.setSample(0, sample, static_cast<float>(std::sin(juce::MathConstants<double>::pi * sample / slow.getNumSamples())));
        check("custom_reject_slow_attack", MetronomeSounds::prepare(slow, 48000).error.isNotEmpty(), "Slow swells are rejected rather than silently moving their late peak onto the grid.");
    }
    std::vector<std::vector<float>> builtIns;
    for (const auto& selection : { juce::String(), juce::String("builtin:woodblock"), juce::String("builtin:cowbell"), juce::String("builtin:mechanical") })
    {
        Metronome metronome;
        metronome.prepareToPlay(48000, 128);
        metronome.setVolume(1.0f);
        const bool accepted = metronome.setClickSound(selection) && metronome.setAccentSound(selection);
        metronome.prepareToPlay(48000, 128);
        metronome.setEnabled(true);
        juce::AudioBuffer<float> audio(1, 4800); audio.clear();
        metronome.getNextAudioBlock(audio, 0);
        builtIns.emplace_back(audio.getReadPointer(0), audio.getReadPointer(0) + audio.getNumSamples());
        metronome.prepareToPlay(44100, 8);
        const bool retained = metronome.getSoundInfo(false)["selection"].toString() == selection;
        audio.clear(); metronome.getNextAudioBlock(audio, 0);
        check("builtin_recall_rate_" + selection, accepted && retained && audio.getMagnitude(0, audio.getNumSamples()) > 0.01f,
            "Each built-in selection survives a device-rate change and renders finite non-silent audio.");
        const auto before = metronome.getSoundInfo(false)["selection"].toString();
        check("builtin_reject_unknown_" + selection, !metronome.setClickSound("builtin:missing")
            && metronome.getSoundInfo(false)["selection"].toString() == before,
            "Unknown choices fail without replacing the selected sound.");
    }
    bool distinct = true;
    for (size_t a = 0; a < builtIns.size(); ++a)
        for (size_t b = a + 1; b < builtIns.size(); ++b)
            distinct = distinct && builtIns[a] != builtIns[b];
    check("four_distinct_builtin_clicks", distinct, "All four built-in sound buffers differ.");
    {
        const auto renderCowbell = [] (int blockSize)
        {
            Metronome metronome;
            metronome.setVolume(1.0f);
            metronome.prepareToPlay(48000.0, blockSize);
            metronome.setBpm(120.0);
            metronome.setClickSound("builtin:cowbell");
            metronome.setAccentSound("builtin:cowbell");
            metronome.setEnabled(true);
            juce::AudioBuffer<float> result(1, 192000);
            for (int offset = 0; offset < result.getNumSamples(); offset += blockSize)
            {
                const int count = juce::jmin(blockSize, result.getNumSamples() - offset);
                juce::AudioBuffer<float> block(1, count); block.clear();
                metronome.getNextTransportBlock(block, offset, true);
                result.copyFrom(0, offset, block, 0, 0, count);
            }
            return result;
        };
        const auto after = renderCowbell(128);
        const auto smallBlocks = renderCowbell(8);
        bool identical = true, expected = true;
        const auto regular = MetronomeSounds::synthesise("builtin:cowbell", false, 48000.0);
        const auto accent = MetronomeSounds::synthesise("builtin:cowbell", true, 48000.0);
        for (int sample = 0; sample < after.getNumSamples(); ++sample)
        {
            identical = identical && after.getSample(0, sample) == smallBlocks.getSample(0, sample);
            const auto& click = (sample / 24000) % 4 == 0 ? accent : regular;
            const int withinBeat = sample % 24000;
            const float expectedSample = withinBeat < click.getNumSamples() ? click.getSample(0, withinBeat) : 0.0f;
            expected = expected && std::abs(after.getSample(0, sample) - expectedSample) < 1.0e-6f;
        }
        check("cowbell_small_buffer_transport_parity", identical && expected,
            "Actual callback output equals the prepared accent/regular strikes on the beat and is unchanged by 8/128-sample block partitioning.");

        const auto auditionPath = juce::SystemStats::getEnvironmentVariable("OPENSTUDIO_METRONOME_AUDITION_DIR", {});
        if (auditionPath.isNotEmpty())
        {
            bool exported = juce::File::isAbsolutePath(auditionPath);
            if (exported)
            {
                const juce::File directory(auditionPath);
                exported = directory.createDirectory().wasOk();
                // Previous approximation is a QA comparison only; production
                // synthesis and playback never read or call this reference.
                const auto oldStrike = [] (bool accented)
                {
                    juce::AudioBuffer<float> result(1, 3840);
                    for (int sample = 0; sample < result.getNumSamples(); ++sample)
                    {
                        const double t = sample / 48000.0;
                        const double pitch = accented ? 1.3 : 1.0;
                        const double value = (std::tanh(3.0 * std::sin(juce::MathConstants<double>::twoPi * 540.0 * pitch * t))
                            + 0.7 * std::tanh(3.0 * std::sin(juce::MathConstants<double>::twoPi * 800.0 * pitch * t))) * std::exp(-65.0 * t);
                        result.setSample(0, sample, static_cast<float>(value * juce::jmin(1.0, (3839 - sample) / 240.0)));
                    }
                    result.applyGain(0.8f / result.getMagnitude(0, result.getNumSamples()));
                    return result;
                };
                const auto oldRegular = oldStrike(false), oldAccent = oldStrike(true);
                juce::AudioBuffer<float> before(1, after.getNumSamples()); before.clear();
                for (int beat = 0; beat < 8; ++beat)
                {
                    const auto& strike = beat % 4 == 0 ? oldAccent : oldRegular;
                    before.copyFrom(0, beat * 24000, strike, 0, 0, strike.getNumSamples());
                }
                juce::AudioBuffer<float> comparison(1, before.getNumSamples() + 48000 + after.getNumSamples()); comparison.clear();
                comparison.copyFrom(0, 0, before, 0, 0, before.getNumSamples());
                comparison.copyFrom(0, before.getNumSamples() + 48000, after, 0, 0, after.getNumSamples());
                const auto write = [&directory] (const juce::String& name, const juce::AudioBuffer<float>& audio)
                {
                    juce::TemporaryFile temporary(directory.getChildFile(name));
                    std::unique_ptr<juce::OutputStream> stream(temporary.getFile().createOutputStream());
                    juce::WavAudioFormat format;
                    auto writer = format.createWriterFor(stream, juce::AudioFormatWriterOptions()
                        .withSampleRate(48000.0).withNumChannels(1).withBitsPerSample(24));
                    const bool written = writer != nullptr && writer->writeFromAudioSampleBuffer(audio, 0, audio.getNumSamples());
                    writer.reset();
                    return written && temporary.overwriteTargetFileWithTemporary();
                };
                exported = write("cowbell-before.wav", before) && exported;
                exported = write("cowbell-revised.wav", after) && exported;
                exported = write("cowbell-before-then-revised.wav", comparison) && exported;
            }
            check("cowbell_audition_export", exported,
                "Native 24-bit/48kHz WAVs exported: two bars before, two bars revised, and a comparison separated by one second. Listening judgment is not asserted.");
        }
    }
    {
        const auto file = juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("OpenStudio-click-import", ".wav");
        juce::WavAudioFormat format;
        std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
        auto writer = format.createWriterFor(stream, juce::AudioFormatWriterOptions().withSampleRate(44100).withNumChannels(2).withBitsPerSample(24));
        const auto input = hit(44100, 0.090, true);
        bool pass = writer != nullptr && writer->writeFromAudioSampleBuffer(input, 0, input.getNumSamples());
        writer.reset();
        Metronome metronome;
        metronome.prepareToPlay(44100, 128);
        pass = pass && metronome.setClickSound(file.getFullPathName());
        const auto saved = metronome.getSoundInfo(false)["selection"].toString();
        pass = pass && juce::File(saved).existsAsFile() && saved != file.getFullPathName();
        pass = pass && metronome.setAccentSound(saved);
        file.deleteFile(); // Only the fixture created above, never a user's sound.
        metronome.prepareToPlay(96000, 8);
        metronome.setEnabled(true);
        juce::AudioBuffer<float> audio(1, 9600); audio.clear(); metronome.getNextAudioBlock(audio, 0);
        pass = pass && std::abs(peakIndex(audio) - 96) <= 4;
        Metronome reloaded;
        pass = pass && reloaded.setClickSound(saved) && reloaded.getSoundInfo(false)["selection"].toString() == saved;
        pass = pass && !reloaded.setClickSound(file.getFullPathName()) && reloaded.getSoundInfo(false)["selection"].toString() == saved;
        check("custom_cache_reload_deleted_source_and_rate_change", pass,
            "A prepared local copy recalls with a stable path after deleting the source and changing device rate; failed replacements preserve it.");
    }
}
