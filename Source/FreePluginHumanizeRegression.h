#pragma once

inline juce::var checkSustainedHumanize()
{
    const auto hz = [](float note) { return 440.0f * std::exp2((note - 69) / 12); };
    const auto note = [](float frequency) { return 69.0f + 12 * std::log2(frequency / 440); };
    const auto configure = [](PitchMapper& mapper, bool sustained, float humanize)
    {
        mapper.setHumanizeMode(sustained ? PitchMapper::HumanizeMode::SustainedNotes : PitchMapper::HumanizeMode::LegacyAmount);
        mapper.setHumanize(humanize);
        mapper.setRetuneSpeed(0);
        mapper.prepare(48000);
    };
    bool legacy = true, onset = true, convergence = true, transpose = true;
    bool gap = true, legato = true, confidence = true, reset = true;
    double sustainedMovement = 0, shortMovement = 0;

    // Analytic legacy invariants independent of detector / stretcher output.
    PitchMapper old;
    configure(old, false, 50);
    old.setCorrectionStrength(.8f); old.setTranspose(12);
    const float legacyExpected = 69.4f + (81.0f - 69.4f) * .4f;
    for (int i = 0; i < 100; ++i)
        legacy = legacy && std::abs(note(old.mapPitch(hz(69.4f), 1, .01f)) - legacyExpected) < .00002f;
    old.setHumanize(100);
    legacy = legacy && std::abs(note(old.mapPitch(hz(69.4f), 1, .01f)) - 69.4f) < .00002f;

    juce::Array<juce::var> durations;
    for (float dt : {.001f, .005f, .01f})
    {
        PitchMapper shortNote, heldNote;
        configure(shortNote, true, 100); configure(heldNote, true, 100);
        for (int i = 0; i < juce::roundToInt(.15f / dt); ++i)
        {
            const float input = 69.15f + .15f * std::sin(juce::MathConstants<float>::twoPi * 6 * i * dt);
            const float output = note(shortNote.mapPitch(hz(input), 1, dt));
            shortMovement = juce::jmax(shortMovement, std::abs(static_cast<double>(output - 69)));
        }
        for (int i = 0; i < juce::roundToInt(.8f / dt); ++i) heldNote.mapPitch(hz(69), 1, dt);
        double movement = 0;
        for (int i = 0; i < juce::roundToInt(.25f / dt); ++i)
        {
            const float input = 69.15f + .15f * std::sin(juce::MathConstants<float>::twoPi * 6 * i * dt);
            movement = juce::jmax(movement, std::abs(static_cast<double>(note(heldNote.mapPitch(hz(input), 1, dt)) - 69)));
        }
        sustainedMovement = juce::jmax(sustainedMovement, movement);
        onset = onset && shortMovement < .00002 && movement > .15;
        for (int i = 0; i < juce::roundToInt(5.0f / dt); ++i) heldNote.mapPitch(hz(69.3f), 1, dt);
        convergence = convergence && std::abs(note(heldNote.mapPitch(hz(69.3f), 1, dt)) - 69) < .0001f;

        // Legato to a new pitch must restore the short-note response after its
        // 40 ms confirmation, even without a silence gap in the input.
        float changed = 0;
        for (int i = 0; i < juce::roundToInt(.1f / dt); ++i) changed = heldNote.mapPitch(hz(71.2f), 1, dt);
        legato = legato && std::abs(note(changed) - 71) < .00002f;

        // A long unvoiced gap must restart note age; low-confidence frames do
        // not earn sustained treatment. A short dropout does retain note age.
        for (int i = 0; i < juce::roundToInt(.8f / dt); ++i) heldNote.mapPitch(hz(71), 1, dt);
        for (int i = 0; i < juce::roundToInt(.06f / dt); ++i) heldNote.mapPitch(0, 0, dt);
        gap = gap && std::abs(note(heldNote.mapPitch(hz(71.3f), 1, dt)) - 71) < .00002f;
        for (int i = 0; i < juce::roundToInt(.8f / dt); ++i) heldNote.mapPitch(hz(71), 1, dt);
        for (int i = 0; i < juce::roundToInt(.8f / dt); ++i) heldNote.mapPitch(hz(71), .1f, dt);
        confidence = confidence && std::abs(note(heldNote.mapPitch(hz(71.3f), 1, dt)) - 71) < .00002f;
        heldNote.reset();
        reset = reset && std::abs(note(heldNote.mapPitch(hz(71.3f), 1, dt)) - 71) < .00002f;
        auto* row = new juce::DynamicObject(); row->setProperty("frameSeconds", dt);
        row->setProperty("sustainedPitchMovementSemitones", movement); durations.add(row);
    }
    for (int semitones : {-24, -12, 0, 12, 24})
    {
        PitchMapper mapper; configure(mapper, true, 100); mapper.setTranspose(semitones);
        float output = 0;
        for (int i = 0; i < 150; ++i) output = mapper.mapPitch(hz(69), 1, .01f);
        transpose = transpose && std::abs(note(output) - (69 + static_cast<float>(semitones))) < .00002f;
    }

    OpenStudioPitchCorrector source;
    source.getMapper().setHumanize(73);
    source.getMapper().setHumanizeMode(PitchMapper::HumanizeMode::SustainedNotes);
    source.getMapper().setTranspose(7);
    source.getMapper().setNoteEnabled(3, false);
    juce::MemoryBlock saved, again;
    source.getStateInformation(saved);
    OpenStudioPitchCorrector restored;
    restored.setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
    restored.getStateInformation(again);
    const bool recall = saved == again && restored.getMapper().getHumanizeMode() == PitchMapper::HumanizeMode::SustainedNotes;
    auto oldState = juce::ValueTree::readFromData(saved.getData(), saved.getSize());
    oldState.removeProperty("humanizeMode", nullptr);
    juce::MemoryBlock missingField;
    juce::MemoryOutputStream oldStream(missingField, false); oldState.writeToStream(oldStream);
    restored.setStateInformation(missingField.getData(), static_cast<int>(missingField.getSize()));
    const bool migration = restored.getMapper().getHumanizeMode() == PitchMapper::HumanizeMode::LegacyAmount
        && restored.getMapper().getHumanize() == 73 && restored.getMapper().getTranspose() == 7
        && !restored.getMapper().isNoteEnabled(3);

    // Exercise the real correction processor: an old preset with no mode field
    // and its explicit Legacy form must produce exactly the same stereo audio.
    const auto render = [&](const juce::MemoryBlock& state)
    {
        auto effect = std::make_unique<OpenStudioPitchCorrector>();
        effect->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
        effect->prepareToPlay(48000, 127);
        juce::AudioBuffer<float> output(2, 48000), block(2, 127); juce::MidiBuffer midi;
        for (int start = 0; start < output.getNumSamples(); start += 127)
        {
            const int count = juce::jmin(127, output.getNumSamples() - start);
            block.setSize(2, count, false, false, true);
            for (int i = 0; i < count; ++i)
            {
                const float sample = .15f * std::sin(static_cast<float>(juce::MathConstants<double>::twoPi * 447 * (start + i) / 48000));
                block.setSample(0, i, sample); block.setSample(1, i, sample * .7f);
            }
            effect->processBlock(block, midi);
            for (int ch = 0; ch < 2; ++ch) output.copyFrom(ch, start, block, ch, 0, count);
        }
        return output;
    };
    juce::MemoryBlock explicitLegacy; restored.getStateInformation(explicitLegacy);
    const auto a = render(missingField), b = render(explicitLegacy);
    double legacyAudioError = 0;
    for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < a.getNumSamples(); ++i)
        legacyAudioError = juce::jmax(legacyAudioError, std::abs(static_cast<double>(a.getSample(ch, i) - b.getSample(ch, i))));

    auto* result = new juce::DynamicObject();
    result->setProperty("plugin", "Compatible sustained-note Humanize");
    result->setProperty("legacyAmountInvariant", legacy);
    result->setProperty("shortNotesRetainRetuneSpeed", onset);
    result->setProperty("sustainedStaticPitchConverges", convergence);
    result->setProperty("transposeUnaffectedByHumanize", transpose);
    result->setProperty("voicingGapRestartsNoteAge", gap);
    result->setProperty("legatoRestartsNoteAge", legato);
    result->setProperty("uncertainFramesDoNotAgeNote", confidence);
    result->setProperty("resetRestartsNoteAge", reset);
    result->setProperty("roundTrip", recall); result->setProperty("missingFieldUsesLegacy", migration);
    result->setProperty("legacyProcessorAudioError", legacyAudioError);
    result->setProperty("shortPitchMovementSemitones", shortMovement);
    result->setProperty("sustainedPitchMovementSemitones", sustainedMovement);
    result->setProperty("frameDurations", durations);
    result->setProperty("pass", legacy && onset && convergence && transpose && gap && legato && confidence && reset && recall && migration && legacyAudioError == 0);
    result->setProperty("reference", "https://antares-web-frontend.sfo3.cdn.digitaloceanspaces.com/documentation/pdfs/AutoTune_2026_User_Guide.pdf");
    result->setProperty("scope", "Original 200 ms grace / 400 ms age ramp, 40 ms voiced-note hysteresis. Deterministic mapper and legacy processor compatibility; commercial equivalence and vocal artifact quality not_asserted.");
    result->setProperty("audioQuality", "not_asserted");
    return result;
}
