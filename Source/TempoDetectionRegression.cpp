#include "TempoDetectionRegression.h"
#include "ClipTempoAnalyzer.h"
#include <cmath>

namespace
{
bool writeFixture(const juce::File& file, const juce::AudioBuffer<float>& buffer)
{
    file.deleteFile();
    juce::WavAudioFormat format;
    std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
    if (!stream) return false;
    auto writer = format.createWriterFor(stream, juce::AudioFormatWriterOptions()
        .withSampleRate(8000.0).withNumChannels(buffer.getNumChannels()).withBitsPerSample(24));
    return writer && writer->writeFromAudioSampleBuffer(buffer, 0, buffer.getNumSamples());
}
void pulse(juce::AudioBuffer<float>& buffer, double seconds, bool invertedStereo = false)
{
    const int position = juce::roundToInt(seconds * 8000.0);
    for (int i = 0; i < 48 && position + i < buffer.getNumSamples(); ++i)
        for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
            buffer.setSample(channel, position + i, 0.8f * std::exp(-static_cast<float>(i) / 8.0f)
                * ((i % 2 == 0) == (!invertedStereo || channel == 0) ? 1.0f : -1.0f));
}
}

void runTempoDetectionRegression(const juce::File& root, const std::function<void(const char*, bool)>& check)
{
    juce::Array<juce::var> evidence;
    const auto analyze = [&](const char* name, const juce::AudioBuffer<float>& buffer) {
        const auto file = root.getChildFile(juce::String(name) + ".wav");
        const bool written = writeFixture(file, buffer);
        auto result = written ? ClipTempoAnalyzer::analyze(file, 0, buffer.getNumSamples() / 8000.0) : juce::var();
        auto* row = new juce::DynamicObject(); row->setProperty("fixture", name); row->setProperty("written", written);
        row->setProperty("classification", "deterministic_invariants"); row->setProperty("analysis", result); evidence.add(row);
        return result;
    };
    juce::AudioBuffer<float> single(1, 8 * 8000); single.clear(); pulse(single, 2.0);
    const auto one = analyze("tempo-single-attack", single);
    check("tempo_single_attack_has_no_repeated_pulse", !one["error"].isVoid() && static_cast<double>(one["confidence"]) == 0.0);

    juce::AudioBuffer<float> noise(1, 12 * 8000);
    juce::uint32 seed = 456789u; float filtered = 0.0f;
    for (int i = 0; i < noise.getNumSamples(); ++i)
    {
        seed = seed * 1664525u + 1013904223u;
        filtered = 0.9f * filtered + 0.1f * (static_cast<float>(static_cast<int>(seed >> 8) - 8388608) / 16777216.0f);
        noise.setSample(0, i, filtered);
    }
    const auto irregular = analyze("tempo-colored-unmetered-noise", noise);
    check("tempo_colored_noise_is_not_confident_music", !irregular["error"].isVoid() && static_cast<double>(irregular["confidence"]) == 0.0);

    juce::AudioBuffer<float> sustained(1, 12 * 8000);
    for (int i = 0; i < sustained.getNumSamples(); ++i)
        sustained.setSample(0, i, 0.3f * std::sin(juce::MathConstants<float>::twoPi * 220.0f * static_cast<float>(i) / 8000.0f));
    const auto tone = analyze("tempo-unmetered-sustained-tone", sustained);
    check("tempo_sustained_tone_does_not_gain_pulse_from_fft_leakage", !tone["error"].isVoid() && static_cast<double>(tone["confidence"]) == 0.0);

    juce::AudioBuffer<float> changing(1, 48 * 8000); changing.clear();
    for (double at = 0.2; at < 24.0; at += 60.0 / 90.0) pulse(changing, at);
    for (double at = 24.2; at < 48.0; at += 60.0 / 150.0) pulse(changing, at);
    const auto variable = analyze("tempo-changing-pulse", changing);
    check("tempo_changing_sections_do_not_claim_constant_certainty", !variable["error"].isVoid()
        || (static_cast<double>(variable["confidence"]) <= 0.35 && static_cast<double>(variable["tempoSpreadBpm"]) > 2.0));

    juce::AudioBuffer<float> antiPhase(2, 12 * 8000); antiPhase.clear();
    for (double at = 0.2; at < 12.0; at += 0.5) pulse(antiPhase, at, true);
    const auto stereo = analyze("tempo-antiphase-clicks", antiPhase);
    check("tempo_antiphase_stereo_does_not_cancel_pulse", stereo["error"].isVoid()
        && std::abs(static_cast<double>(stereo["bpm"]) - 120.0) < 2.5
        && static_cast<double>(stereo["analyzedDurationSeconds"]) <= 60.0);
    auto* report = new juce::DynamicObject(); report->setProperty("checks", evidence); report->setProperty("audibleQuality", "not_asserted");
    root.getChildFile("tempo-consensus-controls.json").replaceWithText(juce::JSON::toString(juce::var(report), true));
}
