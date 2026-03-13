#pragma once

#include <JuceHeader.h>
#include <vector>

/**
 * S13ScriptWindow — Native JUCE window for Lua script GUIs.
 *
 * Provides a framebuffer-based drawing surface (like REAPER's gfx.* API).
 * Scripts draw with immediate-mode calls (rect, line, circle, text, etc.)
 * which render to a juce::Image. The window displays at ~30fps.
 *
 * All access is message-thread only (scripts run on message thread).
 */
class S13ScriptWindow : public juce::DocumentWindow, public juce::Timer
{
public:
    S13ScriptWindow(const juce::String& title, int width, int height);
    ~S13ScriptWindow() override;

    void closeButtonPressed() override;
    bool isWindowOpen() const { return isVisible(); }

    // ---- Drawing API (called by Lua gfx.* functions) ----

    void setColor(float r, float g, float b, float a = 1.0f);
    void drawRect(int x, int y, int w, int h, bool filled = true);
    void drawLine(int x1, int y1, int x2, int y2, bool antiAlias = true);
    void drawCircle(int x, int y, int radius, bool filled = true, bool antiAlias = true);
    void drawArc(int x, int y, int r, float angle1, float angle2, bool antiAlias = true);
    void drawRoundedRect(int x, int y, int w, int h, int radius);
    void drawString(const juce::String& text, int drawFlags = 0);
    void setFont(int size, const juce::String& face = {}, int style = 0);
    std::pair<int, int> measureString(const juce::String& text) const;
    void clearBackground(int color = 0);

    // Drawing position (gfx.x, gfx.y)
    int drawX = 0;
    int drawY = 0;

    // Window/framebuffer dimensions
    int getGfxWidth() const;
    int getGfxHeight() const;

    // ---- Mouse / keyboard state (read by Lua gfx.mouse_*, gfx.getchar) ----

    int mouseX = 0;
    int mouseY = 0;
    int mouseCap = 0;   // Bitmask: 1=L, 2=R, 4=Ctrl, 8=Shift, 16=Alt, 64=Middle
    float mouseWheel = 0.0f;

    // Key queue for gfx.getchar()
    int getChar();
    bool hasChar() const { return !keyQueue.empty(); }

    // Timer for refresh
    void timerCallback() override;

private:
    class Canvas : public juce::Component
    {
    public:
        Canvas(S13ScriptWindow& owner);
        void paint(juce::Graphics& g) override;
        void mouseDown(const juce::MouseEvent& e) override;
        void mouseUp(const juce::MouseEvent& e) override;
        void mouseDrag(const juce::MouseEvent& e) override;
        void mouseMove(const juce::MouseEvent& e) override;
        void mouseWheelMove(const juce::MouseEvent& e, const juce::MouseWheelDetails& w) override;
        bool keyPressed(const juce::KeyPress& key) override;
    private:
        S13ScriptWindow& owner;
    };

    std::unique_ptr<Canvas> canvas;
    juce::Image framebuffer;
    std::unique_ptr<juce::Graphics> fbGraphics;

    juce::Colour currentColor { juce::Colours::white };
    juce::Font currentFont { juce::FontOptions(14.0f) };

    std::vector<int> keyQueue;

    void updateMouseState(const juce::MouseEvent& e);
    void ensureFramebuffer();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(S13ScriptWindow)
};
