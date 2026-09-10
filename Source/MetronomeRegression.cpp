#include "MetronomeRegression.h"
#include "Metronome.h"

#include <array>
#include <limits>
#include <vector>

namespace
{
void prepare(Metronome& metronome)
{
    metronome.prepareToPlay(44100.0, 512);
    metronome.setBpm(120.0);
}

std::vector<float> liveBlock(Metronome& metronome, double position, bool playing, int samples = 128)
{
    juce::AudioBuffer<float> buffer(2, samples);
    buffer.clear();
    metronome.getNextTransportBlock(buffer, position, playing);
    return { buffer.getReadPointer(0), buffer.getReadPointer(0) + samples };
}

bool equalSamples(const std::vector<float>& first, const std::vector<float>& second, size_t skip = 0)
{
    if (first.size() != second.size()) return false;
    for (size_t index = skip; index < first.size(); ++index)
        if (!std::isfinite(first[index]) || !std::isfinite(second[index])
            || std::abs(first[index] - second[index]) > 1.0e-6f) return false;
    return true;
}

bool silent(const std::vector<float>& samples, size_t skip = 0)
{
    return std::all_of(samples.begin() + static_cast<std::ptrdiff_t>(skip), samples.end(),
        [] (float value) { return value == 0.0f; });
}
}

juce::var runMetronomeRegression()
{
    auto* root = new juce::DynamicObject();
    juce::Array<juce::var> suites;
    juce::Array<juce::var> timings;
    bool overallPass = true;
    const auto check = [&] (const juce::String& id, bool pass, const juce::String& detail)
    {
        auto* item = new juce::DynamicObject();
        item->setProperty("id", id);
        item->setProperty("pass", pass);
        item->setProperty("detail", detail);
        suites.add(juce::var(item));
        overallPass = overallPass && pass;
    };
    const auto render = [] (double rate, double bpm, const std::vector<int>& blocks, int numerator = 4, int denominator = 4)
    {
        Metronome metronome;
        metronome.prepareToPlay(rate, 512);
        metronome.setBpm(bpm);
        metronome.setTimeSignature(numerator, denominator);
        metronome.setVolume(0.5f);
        metronome.setEnabled(true);
        const int length = static_cast<int>(rate * 2.0);
        std::vector<float> output(static_cast<size_t>(length));
        int position = 0;
        size_t blockIndex = 0;
        while (position < length)
        {
            const int count = juce::jmin(blocks[blockIndex++ % blocks.size()], length - position);
            float* channels[] { output.data() + position };
            juce::AudioBuffer<float> buffer(channels, 1, count);
            metronome.getNextAudioBlock(buffer, position);
            position += count;
        }
        return output;
    };

    for (const double rate : { 44100.0, 48000.0 })
    {
        for (const double bpm : { 120.0, 137.25 })
        {
            const auto reference = render(rate, bpm, { 512 });
            for (const auto& blocks : std::vector<std::vector<int>> {
                     { 8 }, { 16 }, { 32 }, { 128 }, { 1, 7, 13, 64, 511 } })
            {
                const auto output = render(rate, bpm, blocks);
                float error = 0.0f;
                bool finite = true;
                for (size_t index = 0; index < output.size(); ++index)
                {
                    finite = finite && std::isfinite(output[index]) && std::abs(output[index]) <= 0.5f;
                    error = juce::jmax(error, std::abs(output[index] - reference[index]));
                }
                check("partition_" + juce::String(rate) + "_" + juce::String(bpm) + "_" + juce::String(blocks.front()),
                      finite && error <= 1.0e-6f, "maximum difference=" + juce::String(error, 9));
            }
        }
    }

    for (const int denominator : { 1, 8, 16 })
        for (const double rate : { 44100.0, 48000.0 })
            check("meter_partition_7_" + juce::String(denominator) + "_" + juce::String(rate),
                  equalSamples(render(rate, 137.25, { 8 }, 7, denominator), render(rate, 137.25, { 512 }, 7, denominator)),
                  "Non-quarter-note meter and fractional BPM remain block-size independent.");

    {
        Metronome metronome;
        metronome.prepareToPlay(44100.0, 128);
        metronome.setEnabled(true);
        juce::AudioBuffer<float> buffer(2, 128);
        buffer.clear();
        metronome.getNextAudioBlock(buffer, 0.0);
        metronome.setEnabled(false);
        buffer.clear();
        metronome.getNextAudioBlock(buffer, 128.0);
        metronome.setEnabled(true);
        buffer.clear();
        metronome.getNextAudioBlock(buffer, 128.0);
        check("disabled_restart_does_not_resume_old_click", buffer.getMagnitude(0, 128) == 0.0f,
              "Re-enable at a midbeat position after consuming the stop fade must stay silent until the next beat.");
    }

    {
        Metronome practice, reference;
        prepare(practice);
        prepare(reference);
        practice.setPracticeEnabled(true);
        reference.setEnabled(true);
        bool parity = true;
        int position = 0;
        for (int index = 0; index < 1000; ++index)
        {
            const int block = std::array<int, 5> { 8, 16, 1, 127, 511 }[static_cast<size_t>(index % 5)];
            // Deliberately seek the stopped host back and forth: practice ignores it.
            parity = equalSamples(liveBlock(practice, index % 2 == 0 ? 90000.0 : 123.0, false, block),
                                  liveBlock(reference, position, true, block)) && parity;
            position += block;
        }
        check("practice_ignores_stopped_host_position", parity && !practice.isEnabled(),
              "Sample-exact standalone clock over irregular blocks; transport-click preference remains off.");
    }
    {
        Metronome practice, reference;
        prepare(practice);
        prepare(reference);
        practice.setPracticeEnabled(true);
        reference.setEnabled(true);
        liveBlock(practice, 0, false);
        const auto takeover = liveBlock(practice, 22050, true);
        const auto expected = liveBlock(reference, 22050, true);
        check("transport_takeover_single_click", equalSamples(takeover, expected, 44),
              "Play/Record adopts the host beat after the bounded 1ms old-click tail, without double triggering.");
        const auto continued = liveBlock(practice, 0, false);
        check("transport_stop_continues_practice_phase",
              equalSamples(continued, liveBlock(reference, 22178, true)),
              "Stopping/pausing does not truncate the current click or restart beat one.");
        const auto looped = liveBlock(practice, 0, true);
        Metronome beatOne;
        prepare(beatOne);
        beatOne.setEnabled(true);
        check("transport_restart_and_loop_rephase", equalSamples(looped, liveBlock(beatOne, 0, true), 44),
              "A transport restart/loop boundary uses the destination beat after a bounded tail.");
    }
    {
        Metronome both, reference;
        prepare(both);
        prepare(reference);
        both.setEnabled(true);
        both.setPracticeEnabled(true);
        reference.setEnabled(true);
        bool parity = equalSamples(liveBlock(both, 0, true), liveBlock(reference, 0, true));
        both.setPracticeEnabled(false);
        parity = equalSamples(liveBlock(both, 128, true), liveBlock(reference, 128, true)) && parity;
        check("practice_stop_preserves_enabled_transport_click", parity,
              "Both latches share one generator; stopping practice does not mute the ordinary transport click.");
        const auto stopped = liveBlock(both, 0, false);
        check("ordinary_click_silent_when_stopped", silent(stopped, 44), "Stop tail ends within 1ms.");
    }
    {
        Metronome practice, reference;
        prepare(practice);
        prepare(reference);
        practice.setPracticeEnabled(true);
        reference.setPracticeEnabled(true);
        liveBlock(practice, 0, false);
        // The audio thread must observe a restart even when off/on occurred between callbacks.
        practice.setPracticeEnabled(false);
        practice.setPracticeEnabled(true);
        check("rapid_off_on_restarts_beat_one",
              equalSamples(liveBlock(practice, 0, false), liveBlock(reference, 0, false), 44),
              "Generation-tagged latch prevents a missed restart.");
        practice.setPracticeEnabled(false);
        const auto fade = liveBlock(practice, 0, false);
        check("practice_stop_has_bounded_tail", silent(fade, 44) && silent(liveBlock(practice, 0, false)),
              "No stale click remains after stop, even with a stationary host cursor.");
    }
    {
        Metronome practice, expected;
        prepare(practice);
        prepare(expected);
        practice.setPracticeEnabled(true);
        expected.setEnabled(true);
        liveBlock(practice, 0, false, 11025); // Half a beat at 120 BPM.
        practice.setBpm(240.0);
        expected.setBpm(240.0);
        // Preserve the half-beat phase at the new tempo, rather than skip to beat 2.
        check("practice_tempo_change_preserves_phase",
              equalSamples(liveBlock(practice, 0, false, 12000), liveBlock(expected, 5512.5, true, 12000)),
              "A tempo change preserves musical phase and schedules the next click at the new beat duration.");
    }
    {
        bool safe = true;
        for (const double position : { std::numeric_limits<double>::quiet_NaN(),
                std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(), 1.0e20 })
        {
            Metronome metronome;
            prepare(metronome);
            metronome.setEnabled(true);
            liveBlock(metronome, 0, true);
            const auto invalid = liveBlock(metronome, position, true);
            safe = silent(invalid, 44) && safe;
            const auto recovered = liveBlock(metronome, 0, true);
            safe = !silent(recovered) && std::all_of(recovered.begin(), recovered.end(),
                [] (float value) { return std::isfinite(value) && std::abs(value) <= 1.0f; }) && safe;
        }
        check("invalid_position_recovery", safe, "Invalid positions retire safely; a valid position can restart.");
    }
    {
        Metronome metronome;
        prepare(metronome);
        metronome.setPracticeEnabled(true);
        liveBlock(metronome, std::numeric_limits<double>::infinity(), true);
        check("invalid_host_seek_cannot_poison_practice_clock", !silent(liveBlock(metronome, 0, false)),
              "Stopping after a malformed host seek recovers an independent beat-one clock.");
    }
    {
        const auto ramp = [] (int block)
        {
            Metronome metronome;
            prepare(metronome);
            metronome.setPracticeEnabled(true);
            std::vector<float> output;
            for (int position = 0; position < 512; position += block)
            {
                if (position == 128) metronome.setVolume(0.0f);
                if (position == 256) metronome.setVolume(1.0f);
                const auto samples = liveBlock(metronome, 0, false, block);
                output.insert(output.end(), samples.begin(), samples.end());
            }
            return output;
        };
        const auto reference = ramp(128);
        check("gain_ramp_partition_invariant", equalSamples(reference, ramp(8)) && equalSamples(reference, ramp(16)),
              "Identical sample-aligned gain gestures produce the same 2ms ramp at 8/16/128 samples.");
    }
    {
        Metronome metronome;
        prepare(metronome);
        metronome.setPracticeEnabled(true);
        juce::AudioBuffer<float> buffer(3, 128);
        for (int channel = 0; channel < 3; ++channel)
            juce::FloatVectorOperations::fill(buffer.getWritePointer(channel), 0.125f, 128);
        metronome.getNextTransportBlock(buffer, 0, false);
        bool additive = true;
        for (int sample = 0; sample < 128; ++sample)
            additive = buffer.getSample(0, sample) == buffer.getSample(1, sample)
                && buffer.getSample(2, sample) == 0.125f && additive;
        check("stereo_additive_no_other_channel_mutation", additive && buffer.getMagnitude(0, 128) > 0.125f,
              "Click adds equally to L/R without clearing existing monitored audio or touching other channels.");
    }
    {
        Metronome live, reference;
        prepare(live);
        prepare(reference);
        live.setPracticeEnabled(true);
        reference.setPracticeEnabled(true);
        liveBlock(live, 0, false);
        liveBlock(reference, 0, false);
        const auto file = juce::File::getSpecialLocation(juce::File::tempDirectory)
            .getNonexistentChildFile("OpenStudio-metronome-fixture", ".wav");
        const bool rendered = live.renderToFile(file, 0.0, 0.1);
        check("offline_render_preserves_live_practice_clock", rendered && live.isPracticeEnabled()
              && !live.isEnabled() && equalSamples(liveBlock(live, 0, false), liveBlock(reference, 0, false)),
              "Explicit WAV rendering has independent state and leaves both live latches untouched.");
        check("custom_sound_and_device_reprepare", live.setAccentSound(file.getFullPathName())
              && !silent(liveBlock(live, 0, true)), "A resampled custom click can be published while the clock runs.");
        live.prepareToPlay(48000.0, 8);
        check("device_change_clears_practice", !live.isPracticeEnabled(), "Practice never auto-resumes on a restarted device.");
        live.setPracticeEnabled(true);
        const auto restarted = liveBlock(live, 0, false);
        check("device_reprepare_finite", !silent(restarted) && std::all_of(restarted.begin(), restarted.end(),
              [] (float value) { return std::isfinite(value) && std::abs(value) <= 1.0f; }),
              "Device reprepare rebuilds custom samples and resets the audio clock before callbacks resume.");
        file.deleteFile(); // Only this fixture's uniquely created temporary WAV.
    }

    {
        Metronome metronome;
        bool lifecycle = !metronome.setPracticeEnabled(true);
        prepare(metronome);
        lifecycle = metronome.setPracticeEnabled(true) && lifecycle;
        metronome.setPracticePlaybackAvailable(false);
        lifecycle = !metronome.isPracticeEnabled() && !metronome.setPracticeEnabled(true)
            && metronome.setPracticeEnabled(false) && lifecycle;
        prepare(metronome);
        check("device_unavailable_rejects_start", lifecycle && !metronome.isPracticeEnabled()
              && metronome.setPracticeEnabled(true), "Device reconnect requires an explicit new click-only start.");
    }
    {
        const auto samples = render(44100.0, 120.0, { 8 });
        check("default_click_tail_reaches_zero", samples[2204] == 0.0f && samples[2205] == 0.0f,
              "The 50ms synthesized click has a 1ms terminal taper, not a hard non-zero cutoff.");
    }

    // Measure only the click generator; not a guarantee for plugins/device/UI.
    for (const int block : { 8, 16, 128, 512 })
    {
        Metronome metronome;
        metronome.prepareToPlay(44100.0, block);
        metronome.setEnabled(true);
        juce::AudioBuffer<float> buffer(2, block);
        constexpr int count = 20000;
        double checksum = 0.0;
        const auto started = juce::Time::getHighResolutionTicks();
        for (int index = 0; index < count; ++index)
        {
            buffer.clear();
            metronome.getNextTransportBlock(buffer, static_cast<double>(index * block), true);
            checksum += buffer.getSample(0, block - 1);
        }
        const double microseconds = juce::Time::highResolutionTicksToSeconds(
            juce::Time::getHighResolutionTicks() - started) * 1.0e6 / count;
        auto* timing = new juce::DynamicObject();
        timing->setProperty("blockSize", block);
        timing->setProperty("outputChecksum", checksum);
        timing->setProperty("averageMicroseconds", microseconds);
        timing->setProperty("deadlineMicroseconds", block * 1.0e6 / 44100.0);
        timing->setProperty("classification", "diagnostic_only");
        timings.add(juce::var(timing));
    }
    root->setProperty("overallPass", overallPass);
    root->setProperty("suites", suites);
    root->setProperty("timings", timings);
    root->setProperty("liveTwoPluginASIOSession", "not_asserted");
    return juce::var(root);
}
