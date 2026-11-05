#include "EditingWorkflowRegression.h"
#include "TrackProcessor.h"
#include "MixerGain.h"
#include "LatestAnalysisQueue.h"
#include "ClipTempoAnalyzer.h"

void runEditingWorkflowRegression(const std::function<void(const char*, bool)>& check)
{
    bool silent = true, adjacentAudible = true;
    for (const int blockSize : { 8, 512 })
        for (const bool automated : { false, true })
            for (const float db : { -60.0f, -59.9f, -6.0f })
            {
                TrackProcessor processor;
                processor.setVolume(automated ? 0.0f : db);
                if (automated)
                {
                    processor.getVolumeAutomation().setMode(AutomationMode::Read);
                    processor.getVolumeAutomation().setPoints({ { 0.0, db }, { 1.0, db } });
                }
                processor.prepareToPlay(48000.0, blockSize);
                juce::AudioBuffer<float> input(2, blockSize);
                juce::MidiBuffer midi;
                for (int iteration = 0; iteration < 4; ++iteration)
                {
                    for (int channel = 0; channel < 2; ++channel)
                        for (int sample = 0; sample < blockSize; ++sample) input.setSample(channel, sample, 0.25f);
                    processor.setCurrentBlockPosition(iteration * blockSize / 48000.0);
                    processor.processBlock(input, midi);
                }
                const float magnitude = input.getMagnitude(0, input.getNumSamples());
                if (db == -60.0f) silent = silent && magnitude == 0.0f;
                else adjacentAudible = adjacentAudible && magnitude > 0.0f;
                processor.releaseResources();
            }
    check("mixer_floor_static_automated_8_and_512_exact_silence", silent);
    check("mixer_above_floor_static_automated_remains_audible", adjacentAudible);
    check("mixer_shared_gain_floor_and_adjacent_contract", MixerGain::fromDecibels(-60.0f) == 0.0f
        && MixerGain::fromDecibels(-59.9f) > 0.0f
        && std::abs(MixerGain::fromDecibels(-6.0f) - std::pow(10.0f, -6.0f / 20.0f)) < 1.0e-7f);

    // A blocked first task makes replacing pending work deterministic. No GUI,
    // device or subjective musical estimate is involved in cancellation testing.
    LatestAnalysisQueue queue;
    juce::WaitableEvent entered, release;
    std::atomic<int> completions { 0 }, workCount { 0 }, cancellations { 0 };
    const auto complete = [&](juce::var result) {
        if (static_cast<bool>(result["cancelled"])) ++cancellations;
        ++completions;
    };
    queue.submit("first", [&](const std::atomic<bool>&) {
        ++workCount; entered.signal(); release.wait(3000); return juce::var();
    }, complete);
    const bool started = entered.wait(3000);
    for (int request = 0; request < 20; ++request)
        queue.submit(juce::String(request), [&](const std::atomic<bool>&) { ++workCount; return juce::var(); }, complete);
    queue.cancel("19");
    release.signal();
    queue.shutdown();
    check("tempo_queue_bounds_obsolete_work_and_completes_every_request", started && workCount.load() == 1
        && completions.load() == 21 && cancellations.load() == 21);
    std::atomic<bool> cancelled { true };
    const auto result = ClipTempoAnalyzer::analyze(juce::File(), 0.0, 60.0, &cancelled);
    check("tempo_cancel_before_source_open", static_cast<bool>(result["cancelled"]));
}
