#include "S13ScriptWindow.h"

//==============================================================================
// Canvas (inner component)
//==============================================================================

S13ScriptWindow::Canvas::Canvas(S13ScriptWindow& o) : owner(o)
{
    setWantsKeyboardFocus(true);
    setOpaque(true);
}

void S13ScriptWindow::Canvas::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colours::black);
    if (owner.framebuffer.isValid())
        g.drawImageAt(owner.framebuffer, 0, 0);
}

void S13ScriptWindow::Canvas::mouseDown(const juce::MouseEvent& e) { owner.updateMouseState(e); }
void S13ScriptWindow::Canvas::mouseUp(const juce::MouseEvent& e) { owner.updateMouseState(e); }
void S13ScriptWindow::Canvas::mouseDrag(const juce::MouseEvent& e) { owner.updateMouseState(e); }
void S13ScriptWindow::Canvas::mouseMove(const juce::MouseEvent& e) { owner.updateMouseState(e); }

void S13ScriptWindow::Canvas::mouseWheelMove(const juce::MouseEvent& e,
                                               const juce::MouseWheelDetails& w)
{
    owner.updateMouseState(e);
    owner.mouseWheel += w.deltaY;
}

bool S13ScriptWindow::Canvas::keyPressed(const juce::KeyPress& key)
{
    int code = key.getTextCharacter();
    if (code <= 0)
    {
        int kc = key.getKeyCode();
        if (kc == juce::KeyPress::escapeKey) code = 27;
        else if (kc == juce::KeyPress::backspaceKey) code = 8;
        else if (kc == juce::KeyPress::deleteKey) code = 127;
        else if (kc == juce::KeyPress::leftKey) code = 0x1e000 + 0xd;
        else if (kc == juce::KeyPress::upKey) code = 0x1e000 + 0xe;
        else if (kc == juce::KeyPress::rightKey) code = 0x1e000 + 0xf;
        else if (kc == juce::KeyPress::downKey) code = 0x1e000 + 0x10;
        else return false;
    }
    owner.keyQueue.push_back(code);
    return true;
}

//==============================================================================
// S13ScriptWindow
//==============================================================================

S13ScriptWindow::S13ScriptWindow(const juce::String& title, int width, int height)
    : DocumentWindow(title, juce::Colours::darkgrey, DocumentWindow::allButtons)
{
    setUsingNativeTitleBar(true);
    setResizable(true, false);

    canvas = std::make_unique<Canvas>(*this);
    canvas->setSize(width, height);
    setContentOwned(canvas.release(), true);

    // Re-acquire canvas pointer (now owned by DocumentWindow)
    canvas.reset();

    centreWithSize(width, height);
    setVisible(true);
    toFront(true);

    ensureFramebuffer();
    startTimerHz(30);
}

S13ScriptWindow::~S13ScriptWindow()
{
    stopTimer();
    fbGraphics.reset();
}

void S13ScriptWindow::closeButtonPressed()
{
    setVisible(false);
}

void S13ScriptWindow::ensureFramebuffer()
{
    auto* content = getContentComponent();
    if (!content) return;

    int w = content->getWidth();
    int h = content->getHeight();
    if (w <= 0 || h <= 0) return;

    if (!framebuffer.isValid() || framebuffer.getWidth() != w || framebuffer.getHeight() != h)
    {
        framebuffer = juce::Image(juce::Image::ARGB, w, h, true);
        fbGraphics = std::make_unique<juce::Graphics>(framebuffer);
    }
}

void S13ScriptWindow::timerCallback()
{
    ensureFramebuffer();
    if (auto* content = getContentComponent())
        content->repaint();
}

//==============================================================================
// Drawing API
//==============================================================================

void S13ScriptWindow::setColor(float r, float g, float b, float a)
{
    currentColor = juce::Colour::fromFloatRGBA(r, g, b, a);
    if (fbGraphics)
        fbGraphics->setColour(currentColor);
}

void S13ScriptWindow::drawRect(int x, int y, int w, int h, bool filled)
{
    ensureFramebuffer();
    if (!fbGraphics) return;

    fbGraphics->setColour(currentColor);
    if (filled)
        fbGraphics->fillRect(x, y, w, h);
    else
        fbGraphics->drawRect(x, y, w, h, 1);
}

void S13ScriptWindow::drawLine(int x1, int y1, int x2, int y2, bool antiAlias)
{
    ensureFramebuffer();
    if (!fbGraphics) return;

    fbGraphics->setColour(currentColor);
    if (antiAlias)
        fbGraphics->drawLine(static_cast<float>(x1), static_cast<float>(y1),
                              static_cast<float>(x2), static_cast<float>(y2), 1.0f);
    else
        fbGraphics->drawLine(static_cast<float>(x1), static_cast<float>(y1),
                              static_cast<float>(x2), static_cast<float>(y2), 1.0f);
}

void S13ScriptWindow::drawCircle(int x, int y, int radius, bool filled, bool antiAlias)
{
    ensureFramebuffer();
    if (!fbGraphics) return;
    juce::ignoreUnused(antiAlias);

    fbGraphics->setColour(currentColor);
    float fx = static_cast<float>(x - radius);
    float fy = static_cast<float>(y - radius);
    float fd = static_cast<float>(radius * 2);
    if (filled)
        fbGraphics->fillEllipse(fx, fy, fd, fd);
    else
        fbGraphics->drawEllipse(fx, fy, fd, fd, 1.0f);
}

void S13ScriptWindow::drawArc(int x, int y, int r, float angle1, float angle2, bool antiAlias)
{
    ensureFramebuffer();
    if (!fbGraphics) return;
    juce::ignoreUnused(antiAlias);

    juce::Path path;
    path.addCentredArc(static_cast<float>(x), static_cast<float>(y),
                        static_cast<float>(r), static_cast<float>(r),
                        0.0f, angle1, angle2, true);

    fbGraphics->setColour(currentColor);
    fbGraphics->strokePath(path, juce::PathStrokeType(1.0f));
}

void S13ScriptWindow::drawRoundedRect(int x, int y, int w, int h, int radius)
{
    ensureFramebuffer();
    if (!fbGraphics) return;

    fbGraphics->setColour(currentColor);
    fbGraphics->fillRoundedRectangle(static_cast<float>(x), static_cast<float>(y),
                                      static_cast<float>(w), static_cast<float>(h),
                                      static_cast<float>(radius));
}

void S13ScriptWindow::drawString(const juce::String& text, int drawFlags)
{
    ensureFramebuffer();
    if (!fbGraphics) return;
    juce::ignoreUnused(drawFlags);

    fbGraphics->setColour(currentColor);
    fbGraphics->setFont(currentFont);
    fbGraphics->drawText(text, drawX, drawY, 1000, static_cast<int>(currentFont.getHeight()) + 2,
                          juce::Justification::topLeft, false);
    drawX += static_cast<int>(currentFont.getStringWidthFloat(text));
}

void S13ScriptWindow::setFont(int size, const juce::String& face, int style)
{
    int juceStyle = juce::Font::plain;
    if (style & 1) juceStyle |= juce::Font::bold;
    if (style & 2) juceStyle |= juce::Font::italic;

    if (face.isNotEmpty())
        currentFont = juce::Font(juce::FontOptions(face, static_cast<float>(size), juceStyle));
    else
        currentFont = juce::Font(juce::FontOptions(static_cast<float>(size)));
}

std::pair<int, int> S13ScriptWindow::measureString(const juce::String& text) const
{
    int w = static_cast<int>(currentFont.getStringWidthFloat(text));
    int h = static_cast<int>(currentFont.getHeight());
    return { w, h };
}

void S13ScriptWindow::clearBackground(int color)
{
    ensureFramebuffer();
    if (!fbGraphics) return;

    if (color == 0)
        fbGraphics->fillAll(juce::Colours::black);
    else
    {
        // color is packed RGB (from gfx_clear)
        int r = (color >> 16) & 0xFF;
        int g = (color >> 8) & 0xFF;
        int b = color & 0xFF;
        fbGraphics->fillAll(juce::Colour(static_cast<uint8_t>(r),
                                          static_cast<uint8_t>(g),
                                          static_cast<uint8_t>(b)));
    }
}

int S13ScriptWindow::getGfxWidth() const
{
    if (auto* content = getContentComponent())
        return content->getWidth();
    return 0;
}

int S13ScriptWindow::getGfxHeight() const
{
    if (auto* content = getContentComponent())
        return content->getHeight();
    return 0;
}

int S13ScriptWindow::getChar()
{
    if (keyQueue.empty())
        return 0;
    int ch = keyQueue.front();
    keyQueue.erase(keyQueue.begin());
    return ch;
}

void S13ScriptWindow::updateMouseState(const juce::MouseEvent& e)
{
    mouseX = e.x;
    mouseY = e.y;

    int cap = 0;
    if (e.mods.isLeftButtonDown()) cap |= 1;
    if (e.mods.isRightButtonDown()) cap |= 2;
    if (e.mods.isCtrlDown()) cap |= 4;
    if (e.mods.isShiftDown()) cap |= 8;
    if (e.mods.isAltDown()) cap |= 16;
    if (e.mods.isMiddleButtonDown()) cap |= 64;
    mouseCap = cap;
}
