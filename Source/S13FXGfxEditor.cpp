#include "S13FXGfxEditor.h"
#include "S13FXProcessor.h"

//==============================================================================
S13FXGfxEditor::S13FXGfxEditor(S13FXProcessor& proc)
    : AudioProcessorEditor(proc),
      fxProcessor(proc)
{
    // Default size — JSFX scripts often use 640x480
    setSize(640, 480);
    setResizable(true, true);
    setWantsKeyboardFocus(true);

    // Start rendering at 30fps
    startTimerHz(30);
}

S13FXGfxEditor::~S13FXGfxEditor()
{
    stopTimer();
}

//==============================================================================
void S13FXGfxEditor::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colours::black);

    if (displayBitmap.isValid())
    {
        // Draw the framebuffer scaled to fit the component
        g.drawImage(displayBitmap,
                    getLocalBounds().toFloat(),
                    juce::RectanglePlacement::stretchToFit);
    }
}

void S13FXGfxEditor::resized()
{
    // Framebuffer will be resized on next timer tick
}

//==============================================================================
// Mouse input

void S13FXGfxEditor::updateMouseState(const juce::MouseEvent& e)
{
    auto scaleFactor = fxProcessor.getGfxScaleFactor();
    ysfxMouseX = static_cast<int32_t>(e.x * scaleFactor);
    ysfxMouseY = static_cast<int32_t>(e.y * scaleFactor);
    ysfxMouseMods = getYsfxMods(e.mods);
    ysfxMouseButtons = getYsfxButtons(e.mods);
}

void S13FXGfxEditor::mouseDown(const juce::MouseEvent& e)
{
    updateMouseState(e);
}

void S13FXGfxEditor::mouseDrag(const juce::MouseEvent& e)
{
    updateMouseState(e);
}

void S13FXGfxEditor::mouseUp(const juce::MouseEvent& e)
{
    updateMouseState(e);
}

void S13FXGfxEditor::mouseMove(const juce::MouseEvent& e)
{
    updateMouseState(e);
}

void S13FXGfxEditor::mouseWheelMove(const juce::MouseEvent& e,
                                     const juce::MouseWheelDetails& wheel)
{
    updateMouseState(e);
    ysfxWheel += wheel.deltaY;
    ysfxHWheel += wheel.deltaX;
}

//==============================================================================
// Keyboard input

bool S13FXGfxEditor::keyPressed(const juce::KeyPress& key)
{
    uint32_t mods = 0;
    if (key.getModifiers().isShiftDown()) mods |= ysfx_mod_shift;
    if (key.getModifiers().isCtrlDown()) mods |= ysfx_mod_ctrl;
    if (key.getModifiers().isAltDown()) mods |= ysfx_mod_alt;
    if (key.getModifiers().isCommandDown()) mods |= ysfx_mod_super;

    uint32_t ysfxKey = 0;
    int keyCode = key.getKeyCode();

    // Map JUCE key codes to YSFX key codes
    if (keyCode == juce::KeyPress::backspaceKey) ysfxKey = ysfx_key_backspace;
    else if (keyCode == juce::KeyPress::escapeKey) ysfxKey = ysfx_key_escape;
    else if (keyCode == juce::KeyPress::deleteKey) ysfxKey = ysfx_key_delete;
    else if (keyCode == juce::KeyPress::leftKey) ysfxKey = ysfx_key_left;
    else if (keyCode == juce::KeyPress::upKey) ysfxKey = ysfx_key_up;
    else if (keyCode == juce::KeyPress::rightKey) ysfxKey = ysfx_key_right;
    else if (keyCode == juce::KeyPress::downKey) ysfxKey = ysfx_key_down;
    else if (keyCode == juce::KeyPress::pageUpKey) ysfxKey = ysfx_key_page_up;
    else if (keyCode == juce::KeyPress::pageDownKey) ysfxKey = ysfx_key_page_down;
    else if (keyCode == juce::KeyPress::homeKey) ysfxKey = ysfx_key_home;
    else if (keyCode == juce::KeyPress::endKey) ysfxKey = ysfx_key_end;
    else if (keyCode == juce::KeyPress::insertKey) ysfxKey = ysfx_key_insert;
    else if (keyCode >= juce::KeyPress::F1Key && keyCode <= juce::KeyPress::F12Key)
        ysfxKey = ysfx_key_f1 + static_cast<uint32_t>(keyCode - juce::KeyPress::F1Key);
    else
    {
        // For printable characters, use the text character
        auto textChar = key.getTextCharacter();
        if (textChar > 0)
            ysfxKey = static_cast<uint32_t>(textChar);
    }

    if (ysfxKey > 0)
    {
        pendingKeys.push({ mods, ysfxKey, true });
        return true;
    }

    return false;
}

bool S13FXGfxEditor::keyStateChanged(bool isKeyDown)
{
    juce::ignoreUnused(isKeyDown);
    return false;
}

//==============================================================================
// Timer — render @gfx section

void S13FXGfxEditor::timerCallback()
{
    ysfx_t* effect = fxProcessor.getEffect();
    if (!effect)
        return;

    int w = getWidth();
    int h = getHeight();
    if (w <= 0 || h <= 0)
        return;

    // Determine scale factor (HiDPI support)
    float scaleFactor = 1.0f;
    if (ysfx_gfx_wants_retina(effect))
    {
        auto* display = juce::Desktop::getInstance().getDisplays()
                           .getDisplayForPoint(getScreenPosition());
        if (display)
            scaleFactor = static_cast<float>(display->scale);
    }
    fxProcessor.setGfxScaleFactor(scaleFactor);

    int fbW = static_cast<int>(static_cast<float>(w) * scaleFactor);
    int fbH = static_cast<int>(static_cast<float>(h) * scaleFactor);

    // Resize framebuffer if needed
    if (!framebuffer.isValid() || framebuffer.getWidth() != fbW || framebuffer.getHeight() != fbH)
        framebuffer = juce::Image(juce::Image::ARGB, fbW, fbH, true);

    // Lock the effect for gfx access (prevents conflict with audio thread)
    auto& gfxMutex = fxProcessor.getGfxMutex();
    std::lock_guard<std::mutex> lock(gfxMutex);

    // Push pending key events
    while (!pendingKeys.empty())
    {
        auto& ke = pendingKeys.front();
        ysfx_gfx_add_key(effect, ke.mods, ke.key, ke.press);
        pendingKeys.pop();
    }

    // Update mouse state
    ysfx_gfx_update_mouse(effect, ysfxMouseMods, ysfxMouseX, ysfxMouseY,
                           ysfxMouseButtons, ysfxWheel, ysfxHWheel);
    ysfxWheel = 0.0f;
    ysfxHWheel = 0.0f;

    // Render @gfx into framebuffer
    bool mustRepaint;
    {
        juce::Image::BitmapData bdata(framebuffer, juce::Image::BitmapData::readWrite);

        ysfx_gfx_config_t gc {};
        gc.user_data = this;
        gc.pixel_width = static_cast<uint32_t>(bdata.width);
        gc.pixel_height = static_cast<uint32_t>(bdata.height);
        gc.pixel_stride = static_cast<uint32_t>(bdata.lineStride);
        gc.pixels = bdata.data;
        gc.scale_factor = static_cast<ysfx_real>(scaleFactor);
        gc.show_menu = &showMenuCallback;
        gc.set_cursor = &setCursorCallback;
        gc.get_drop_file = &getDropFileCallback;

        ysfx_gfx_setup(effect, &gc);
        mustRepaint = ysfx_gfx_run(effect);
    }

    if (mustRepaint)
    {
        // Copy to display bitmap (double buffering)
        if (!displayBitmap.isValid() ||
            displayBitmap.getWidth() != framebuffer.getWidth() ||
            displayBitmap.getHeight() != framebuffer.getHeight())
        {
            displayBitmap = juce::Image(juce::Image::ARGB,
                                         framebuffer.getWidth(),
                                         framebuffer.getHeight(), false);
        }

        juce::Image::BitmapData src(framebuffer, juce::Image::BitmapData::readOnly);
        juce::Image::BitmapData dst(displayBitmap, juce::Image::BitmapData::writeOnly);

        if (src.lineStride == dst.lineStride)
            std::memcpy(dst.data, src.data, static_cast<size_t>(fbH * src.lineStride));
        else
        {
            for (int row = 0; row < fbH; ++row)
                std::memcpy(dst.getLinePointer(row), src.getLinePointer(row),
                            static_cast<size_t>(fbW * src.pixelStride));
        }

        repaint();
    }
}

//==============================================================================
// Modifier / button helpers

uint32_t S13FXGfxEditor::getYsfxMods(const juce::ModifierKeys& mods) const
{
    uint32_t m = 0;
    if (mods.isShiftDown()) m |= ysfx_mod_shift;
    if (mods.isCtrlDown()) m |= ysfx_mod_ctrl;
    if (mods.isAltDown()) m |= ysfx_mod_alt;
    if (mods.isCommandDown()) m |= ysfx_mod_super;
    return m;
}

uint32_t S13FXGfxEditor::getYsfxButtons(const juce::ModifierKeys& mods) const
{
    uint32_t b = 0;
    if (mods.isLeftButtonDown()) b |= ysfx_button_left;
    if (mods.isMiddleButtonDown()) b |= ysfx_button_middle;
    if (mods.isRightButtonDown()) b |= ysfx_button_right;
    return b;
}

//==============================================================================
// YSFX gfx callbacks

int32_t S13FXGfxEditor::showMenuCallback(void* userData, const char* menuSpec,
                                          int32_t xpos, int32_t ypos)
{
    auto* editor = static_cast<S13FXGfxEditor*>(userData);
    if (!editor || !menuSpec)
        return 0;

    // Parse the JSFX menu spec and show as a JUCE popup menu
    ysfx_menu_u desc { ysfx_parse_menu(menuSpec) };
    if (!desc)
        return 0;

    juce::PopupMenu menu;
    // Simple flat menu parsing (handles most JSFX menus)
    for (uint32_t i = 0; i < desc->insn_count; ++i)
    {
        ysfx_menu_insn_t insn = desc->insns[i];
        switch (insn.opcode)
        {
            case ysfx_menu_item:
                menu.addItem(static_cast<int>(insn.id),
                             juce::CharPointer_UTF8(insn.name),
                             (insn.item_flags & ysfx_menu_item_disabled) == 0,
                             (insn.item_flags & ysfx_menu_item_checked) != 0);
                break;
            case ysfx_menu_separator:
                menu.addSeparator();
                break;
            default:
                break;
        }
    }

    juce::PopupMenu::Options options;
    auto screenPos = editor->localPointToGlobal(juce::Point<int>(xpos, ypos));
    options = options.withTargetScreenArea(juce::Rectangle<int>(screenPos.x, screenPos.y, 1, 1));
    return menu.showMenu(options);
}

void S13FXGfxEditor::setCursorCallback(void* userData, int32_t cursor)
{
    auto* editor = static_cast<S13FXGfxEditor*>(userData);
    if (!editor)
        return;

    editor->currentCursor = cursor;

    // Map JSFX/Windows cursor constants to JUCE cursors
    juce::MouseCursor mc;
    switch (cursor)
    {
        case 32513: mc = juce::MouseCursor::IBeamCursor; break;        // ocr_ibeam
        case 32515: mc = juce::MouseCursor::CrosshairCursor; break;    // ocr_cross
        case 32644: mc = juce::MouseCursor::LeftRightResizeCursor; break; // ocr_sizewe
        case 32645: mc = juce::MouseCursor::UpDownResizeCursor; break;    // ocr_sizens
        case 32649: mc = juce::MouseCursor::PointingHandCursor; break;    // ocr_hand
        case 32514: mc = juce::MouseCursor::WaitCursor; break;           // ocr_wait
        case 32648: mc = juce::MouseCursor::NoCursor; break;             // ocr_no
        default:    mc = juce::MouseCursor::NormalCursor; break;
    }
    editor->setMouseCursor(mc);
}

const char* S13FXGfxEditor::getDropFileCallback(void* userData, int32_t index)
{
    juce::ignoreUnused(userData, index);
    // File drag-and-drop not yet supported for JSFX
    return nullptr;
}
