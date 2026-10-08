#pragma once
#include <limits>
#include "PolyPitchDetector.h"
#include "RuntimeLocation.h"

// Real bundled-model tests: deterministic data/timing, not transcription quality.
template <typename Check>
void runBasicPitchRegression (const juce::File& directory, Check&& check)
{
    PolyPitchDetector detector;
    std::vector<float> silence (22050, 0.0f);
    const auto unloaded = detector.analyze (silence.data(), 22050, 22050, "unloaded");
    check("basic_pitch_unloaded_error_reaches_bridge", PolyPitchDetector::resultToJSON (unloaded)["error"].toString().isNotEmpty());
#if OPENSTUDIO_HAS_ONNXRUNTIME
    const auto model = OpenStudioRuntime::executableFile().getParentDirectory().getChildFile("models/basic_pitch_nmp.onnx");
    const auto loaded = detector.loadModel (model);
    check("basic_pitch_bundled_model_loads", loaded);
    if (! loaded) return;
    const auto empty = detector.analyze (nullptr, 0, 22050, "empty");
    check("basic_pitch_invalid_input_is_error", empty.error.isNotEmpty());
    silence[0] = std::numeric_limits<float>::quiet_NaN();
    check("basic_pitch_nonfinite_input_is_error", detector.analyze (silence.data(), 22050, 22050, "nan").error.isNotEmpty());
    silence[0] = 0.0f;
    const auto silent = detector.analyze (silence.data(), 22050, 22050, "silence");
    check("basic_pitch_silence_success_has_no_notes", silent.error.isEmpty() && silent.notes.empty());
    for (const auto sampleRate : {22050, 44100, 48000})
    {
        for (const auto duration : {0.1, 3.0, 8.0})
        {
            const auto samples = static_cast<int> (std::round (sampleRate * duration));
            std::vector<float> audio (static_cast<size_t> (samples));
            for (int i = 0; i < samples; ++i)
            {
                const auto t = static_cast<double> (i) / sampleRate;
                // A4 sustained across every inference seam; short attack/release.
                const auto envelope = std::min ({1.0, t / 0.02, (duration - t) / 0.02});
                audio[static_cast<size_t> (i)] = static_cast<float> (0.4 * envelope * std::sin (juce::MathConstants<double>::twoPi * 440.0 * t));
            }
            const auto result = detector.analyze (audio.data(), samples, sampleRate, "tone");
            const auto name = juce::String(sampleRate) + "_" + juce::String(duration, 1);
            check(("basic_pitch_windowed_inference_" + name).toRawUTF8(), result.error.isEmpty()
                && result.noteActivation.size() == static_cast<size_t> (std::ceil (std::ceil (samples * 22050.0 / sampleRate) / 256.0))
                && result.pitchSalience.size() == result.noteActivation.size());
            bool bounded = true;
            bool sustainedA = false;
            for (const auto& note : result.notes)
            {
                bounded = bounded && note.startTime >= 0 && note.endTime > note.startTime
                    && note.endTime <= duration + 0.0001 && note.midiPitch >= 21 && note.midiPitch <= 108;
                sustainedA = sustainedA || (note.midiPitch == 69 && note.startTime < 0.2 && note.endTime > duration - 0.3);
            }
            check(("basic_pitch_notes_within_source_" + name).toRawUTF8(), bounded);
            if (duration >= 3.0)
                check(("basic_pitch_known_note_spans_window_seams_" + name).toRawUTF8(), sustainedA);
            directory.getChildFile("basic-pitch-" + name + ".json").replaceWithText (
                juce::JSON::toString (PolyPitchDetector::resultToJSON (result)));
        }
    }
#else
    juce::ignoreUnused (directory);
#endif
}
