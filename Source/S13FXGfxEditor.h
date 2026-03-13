#pragma once

#include <JuceHeader.h>
#include <ysfx.h>
#include <queue>
#include <mutex>

class S13FXProcessor;

/**
 * S13FXGfxEditor — JUCE AudioProcessorEditor that renders a JSFX @gfx section.
 *
 * Uses a juce::Image as the framebuffer, renders at ~30fps via Timer,
 * and routes mouse/keyboard input to the YSFX gfx API.
 *
 * Slots into PluginWindowManager exactly like a VST3 editor.
 */
class S13FXGfxEditor : public juce::AudioProcessorEditor, public juce::Timer
{
public:
    explicit S13FXGfxEditor(S13FXProcessor& processor);
    ~S13FXGfxEditor() override;

    // juce::Component
    void paint(juce::Graphics& g) override;
    void resized() override;

    // Mouse input
    void mouseDown(const juce::MouseEvent& e) override;
    void mouseDrag(const juce::MouseEvent& e) override;
    void mouseUp(const juce::MouseEvent& e) override;
    void mouseMove(const juce::MouseEvent& e) override;
    void mouseWheelMove(const juce::MouseEvent& e, const juce::MouseWheelDetails& wheel) override;

    // Keyboard input
    bool keyPressed(const juce::KeyPress& key) override;
    bool keyStateChanged(bool isKeyDown) override;

    // Timer — drives @gfx rendering
    void timerCallback() override;

private:
    S13FXProcessor& fxProcessor;

    // Framebuffer
    juce::Image framebuffer;
    juce::Image displayBitmap; // Double-buffered copy for paint()

    // Input state for YSFX
    uint32_t ysfxMouseMods = 0;
    int32_t ysfxMouseX = 0;
    int32_t ysfxMouseY = 0;
    uint32_t ysfxMouseButtons = 0;
    float ysfxWheel = 0.0f;
    float ysfxHWheel = 0.0f;

    struct KeyEvent
    {
        uint32_t mods;
        uint32_t key;
        bool press;
    };
    std::queue<KeyEvent> pendingKeys;

    // Cursor callback state
    int currentCursor = -1;

    // Helper methods
    uint32_t getYsfxMods(const juce::ModifierKeys& mods) const;
    uint32_t getYsfxButtons(const juce::ModifierKeys& mods) const;
    void updateMouseState(const juce::MouseEvent& e);

    // YSFX gfx callbacks
    static int32_t showMenuCallback(void* userData, const char* menuSpec, int32_t xpos, int32_t ypos);
    static void setCursorCallback(void* userData, int32_t cursor);
    static const char* getDropFileCallback(void* userData, int32_t index);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13FXGfxEditor)
};
