#pragma once
#include "TrackProcessor.h"
// Opt-in qualification of a real external module, using the production track
// host without opening an audio device or reading/writing the user's catalog.
namespace PluginQualification
{
inline std::unique_ptr<juce::XmlElement> run(juce::AudioPluginFormatManager& formats,
                                           const juce::PluginDescription& description,
                                           bool checkEditor)
{
    auto report = std::make_unique<juce::XmlElement>("QUALIFICATION");
    report->setAttribute("name", description.name);
    report->setAttribute("subjectiveAudio", "not_asserted");
    bool success = true;
    auto check = [&](const juce::String& id, bool pass, const juce::String& detail = {}) {
        auto* item = report->createNewChildElement("CHECK");
        item->setAttribute("id", id); item->setAttribute("status", pass ? "pass" : "fail");
        item->setAttribute("detail", detail); success = success && pass;
    };
    juce::MemoryBlock savedState;
    int parameterIndex = -1;
    float savedParameter = 0.0f;
    for (const auto rate : {44100.0, 48000.0, 96000.0})
    {
        for (const auto blockSize : {128, 512})
        {
            const auto label = juce::String(static_cast<int>(rate)) + "_" + juce::String(blockSize);
            juce::String error;
            auto plugin = formats.createPluginInstance(description, rate, 512, error);
            check(label + "_instantiate", plugin != nullptr, error);
            if (!plugin) continue;
            if (savedState.getSize() > 0)
            {
                plugin->setStateInformation(savedState.getData(), static_cast<int>(savedState.getSize()));
                check(label + "_state_recall", parameterIndex >= 0
                    && parameterIndex < plugin->getParameters().size()
                    && std::abs(plugin->getParameters()[parameterIndex]->getValue() - savedParameter) < 0.0001f);
            }
            else
            {
                for (int i = 0; i < plugin->getParameters().size(); ++i)
                {
                    auto* parameter = plugin->getParameters()[i];
                    // JUCE exposes VST3 MIDI CC mappings as parameters too.
                    // Bank/program controllers are not an effect/instrument
                    // setting and may intentionally select a silent patch.
                    if (!parameter->isAutomatable() || parameter->isBoolean() || parameter->getNumSteps() < 100
                        || parameter->getName(100).startsWith("MIDI ")) continue;
                    parameterIndex = i;
                    parameter->setValueNotifyingHost(0.371f);
                    break;
                }
            }
            auto* instance = plugin.get();
            TrackProcessor track;
            track.prepareToPlay(rate, blockSize);
            if (description.isInstrument)
            {
                track.setTrackType(TrackType::Instrument);
                track.setInstrument(std::move(plugin), rate, blockSize);
            }
            else
            {
                check(label + "_attach_fx", track.addTrackFX(std::move(plugin), rate, blockSize));
            }
            juce::AudioBuffer<float> block(2, blockSize);
            juce::MidiBuffer midi;
            float peak = 0.0f;
            bool finite = true;
            for (int step = 0; step < 64; ++step)
            {
                block.clear(); midi.clear();
                if (description.isInstrument)
                {
                    if (step == 0) midi.addEvent(juce::MidiMessage::noteOn(1, 60, 0.5f), 0);
                    if (step == 32) midi.addEvent(juce::MidiMessage::noteOff(1, 60), 0);
                }
                else
                {
                    for (int sample = 0; sample < blockSize; ++sample)
                    {
                        const auto value = 0.05f * std::sin(static_cast<float>(
                            (step * blockSize + sample) * juce::MathConstants<double>::twoPi * 440.0 / rate));
                        block.setSample(0, sample, value); block.setSample(1, sample, value);
                    }
                }
                finite = track.tryProcessBlock(block, midi) && finite;
                for (int ch = 0; ch < 2; ++ch)
                    for (int sample = 0; sample < blockSize; ++sample)
                    {
                        const auto value = block.getSample(ch, sample);
                        finite = std::isfinite(value) && finite;
                        peak = juce::jmax(peak, std::abs(value));
                    }
            }
            check(label + "_process", finite && peak > 0.000001f,
                  "finite=" + juce::String(finite ? "true" : "false") + "; peak=" + juce::String(peak, 6));
            if (!description.isInstrument)
                check(label + "_host_fault", track.getProcessorFault(false, 0) == 0);
            if (savedState.getSize() == 0)
            {
                instance->getStateInformation(savedState);
                if (parameterIndex >= 0) savedParameter = instance->getParameters()[parameterIndex]->getValue();
                check("save_state", savedState.getSize() > 0 && parameterIndex >= 0,
                      "bytes=" + juce::String(static_cast<int>(savedState.getSize()))
                      + "; parameter=" + (parameterIndex >= 0 ? instance->getParameters()[parameterIndex]->getName(100) : "none")
                      + "; value=" + juce::String(savedParameter, 6));
                if (checkEditor)
                {
                    for (int cycle = 0; cycle < 2; ++cycle)
                    {
                        juce::DocumentWindow window("OpenStudio plugin qualification: " + description.name,
                            juce::Colours::darkgrey, juce::DocumentWindow::closeButton);
                        window.setUsingNativeTitleBar(true);
                        auto* editor = instance->hasEditor() ? instance->createEditorAndMakeActive()
                            : new juce::GenericAudioProcessorEditor(*instance);
                        check("editor_create_" + juce::String(cycle), editor != nullptr,
                              instance->hasEditor() ? "native editor" : "generic parameter editor");
                        if (editor != nullptr)
                        {
                            window.setContentOwned(editor, true);
                            window.centreWithSize(editor->getWidth(), editor->getHeight());
                            window.setVisible(true);
                            juce::MessageManager::getInstance()->runDispatchLoopUntil(600);
                            check("editor_visible_" + juce::String(cycle), editor->isShowing()
                                && editor->getWidth() > 0 && editor->getHeight() > 0);
                            window.setVisible(false);
                            instance->editorBeingDeleted(editor);
                            window.clearContentComponent();
                            juce::MessageManager::getInstance()->runDispatchLoopUntil(100);
                        }
                    }
                }
            }
            track.releaseResources();
        }
    }
    report->setAttribute("success", success);
    report->setAttribute("editorCheckRequested", checkEditor);
    return report;
}
}
