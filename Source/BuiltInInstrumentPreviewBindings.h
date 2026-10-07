#pragma once
#include "BuiltInEffects2.h"

// Build the pointer list on the control thread; the callback only copies atomics.
inline std::function<void()> bindBuiltInPreviewControls(const std::shared_ptr<juce::AudioProcessor>& source, juce::AudioProcessor& clone)
{
    std::vector<std::pair<std::atomic<float>*, std::atomic<float>*>> controls;
    const auto add = [&](std::atomic<float>& from, std::atomic<float>& to) { controls.emplace_back(&from, &to); };
    if (auto* original = dynamic_cast<OpenStudioBasicSynthInstrument*>(source.get()))
        if (auto* copy = dynamic_cast<OpenStudioBasicSynthInstrument*>(&clone))
        {
            add(original->attackMs, copy->attackMs);
            add(original->releaseMs, copy->releaseMs);
            add(original->decayMs, copy->decayMs);
            add(original->sustain, copy->sustain);
            add(original->oscillatorBlend, copy->oscillatorBlend);
            for (const auto& control : OpenStudioBasicSynthInstrument::modulationControls) add(original->*control.member, copy->*control.member);
            for (const auto& control : OpenStudioBasicSynthInstrument::macroMappings) add(original->*control.member, copy->*control.member);
            add(original->brightness, copy->brightness);
            add(original->detuneCents, copy->detuneCents);
            add(original->subLevel, copy->subLevel);
            add(original->noiseLevel, copy->noiseLevel);
            add(original->outputGain, copy->outputGain);
        }
    if (auto* original = dynamic_cast<OpenStudioPianoInstrument*>(source.get()))
        if (auto* copy = dynamic_cast<OpenStudioPianoInstrument*>(&clone))
        {
            add(original->tone, copy->tone);
            add(original->body, copy->body);
            add(original->hammer, copy->hammer);
            for (const auto& control : OpenStudioPianoInstrument::performanceControls) add(original->*control.member, copy->*control.member);
            for (const auto& control : OpenStudioPianoInstrument::coupledBodyControls) add(original->*control.member, copy->*control.member);
            add(original->releaseMs, copy->releaseMs);
            add(original->outputGain, copy->outputGain);
            add(original->resonance, copy->resonance);
            add(original->stereoWidth, copy->stereoWidth);
            add(original->model, copy->model);
        }
    if (auto* original = dynamic_cast<OpenStudioCleanGuitarInstrument*>(source.get()))
        if (auto* copy = dynamic_cast<OpenStudioCleanGuitarInstrument*>(&clone))
        {
            add(original->model, copy->model);
            add(original->tone, copy->tone);
            add(original->body, copy->body);
            add(original->pickNoise, copy->pickNoise);
            for (const auto& control : OpenStudioCleanGuitarInstrument::stringControls) add(original->*control.member, copy->*control.member);
            for (const auto& control : OpenStudioCleanGuitarInstrument::articulationControls) add(original->*control.member, copy->*control.member);
            for (const auto& control : OpenStudioCleanGuitarInstrument::coupledBodyControls) add(original->*control.member, copy->*control.member);
            add(original->releaseMs, copy->releaseMs);
            add(original->chorus, copy->chorus);
            add(original->stringMode, copy->stringMode);
            add(original->bendRangeSemitones, copy->bendRangeSemitones);
            add(original->outputGain, copy->outputGain);
        }
    if (auto* original = dynamic_cast<OpenStudioDrumInstrument*>(source.get()))
        if (auto* copy = dynamic_cast<OpenStudioDrumInstrument*>(&clone))
        {
            add(original->kit, copy->kit);
            add(original->tuning, copy->tuning);
            add(original->ambience, copy->ambience);
            add(original->outputGain, copy->outputGain);
            add(original->hihatTightness, copy->hihatTightness);
            add(original->mapPreset, copy->mapPreset);
            add(original->articulationEngine,copy->articulationEngine);add(original->customMapEnabled,copy->customMapEnabled);
            for(size_t i=0;i<original->noteMap.size();++i)add(original->noteMap[i],copy->noteMap[i]);
            add(original->punch, copy->punch);
            add(original->stereoWidth, copy->stereoWidth);
            add(original->velocityCurve, copy->velocityCurve);
            for (size_t i = 0; i < original->pieceGain.size(); ++i)
            { add(original->pieceGain[i], copy->pieceGain[i]); add(original->pieceTuning[i], copy->pieceTuning[i]); add(original->piecePan[i], copy->piecePan[i]); add(original->pieceDecay[i],copy->pieceDecay[i]); }
        }
    return [source, controls = std::move(controls)] {
        juce::ignoreUnused(source); // Retire the source owner on the control thread with the lease.
        for (const auto& control : controls) control.second->store(control.first->load(std::memory_order_relaxed), std::memory_order_relaxed);
    };
}
