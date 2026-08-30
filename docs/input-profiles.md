# Keyboard, Hotkey, Mouse, and Scroll Profiles

OpenStudio can adopt the familiar input conventions of another DAW without
changing the project or audio engine. Keyboard and mouse/scroll behavior are
separate choices: for example, you can use Cubase-style keys with REAPER-style
timeline scrolling.

## Choose a profile

1. Open **Help > Keyboard Shortcuts**.
2. Choose a **Keyboard profile**.
3. Choose a separate **Mouse & scroll profile**.
4. Search the action list to see the effective keys and their active scope.

The first-run profile card exposes both selectors; Getting Started shows the
current choices and directs you to the shortcut window. Preferences also shows the
current mouse behavior and exact modifier overrides.

The selected keyboard base, mouse/scroll base, custom keyboard profiles, and
fine-grained per-gesture mouse overrides are persisted. Named/importable custom
profiles currently apply to the keyboard only. Mouse overrides are validated
before loading and are synchronized to detached editor windows with the active
base profiles.

## Binding vocabulary

- **Primary** is Control on Windows/Linux and Command on macOS.
- The legacy portable **Alt** token means Alt on Windows/Linux and physical
  Control on macOS. Profile definitions use explicit **Option**, **Control**,
  **Command**, or **Meta** whenever the physical modifier matters.
- Numpad bindings and physical `Code:` bindings remain distinct from the
  character printed on a key. This prevents layout-dependent labels from
  silently changing the intended physical shortcut.

## Built-in profiles

OpenStudio currently includes 19 built-in profile families:

| OpenStudio | Pro Tools | Cubase / Nuendo | REAPER | Audacity |
|---|---|---|---|---|
| Logic Pro | FL Studio | Ableton Live | Studio One | Bitwig Studio |
| Reason | Cakewalk / Sonar | GarageBand | Digital Performer | Ardour |
| Adobe Audition | Mixcraft | Waveform | Renoise | |

A profile maps documented source-DAW conventions onto equivalent OpenStudio
actions. It does not claim to reproduce commands for which OpenStudio has no
matching operation. Most profiles keep the OpenStudio binding when the source
profile does not define an override; explicit empty mappings prevent known
collisions or false equivalence. Digital Performer, Waveform, and Renoise use a
strict policy, so commands without a verified mapping remain unassigned. The
deliberate exception is `Esc` for closing an active modal, which remains an
application-level safety control.

Profiles remain selectable on every supported OpenStudio platform. When the
source DAW is not native to the current operating system, the UI labels the
selection as cross-platform emulation. Printed key names are normalized for the
current platform, including Command/Control and Option/Alt distinctions.

## Custom keyboard profiles

The Keyboard Shortcuts window can create named profiles on top of any built-in
base profile. A custom profile can be created, duplicated, renamed, deleted,
exported to JSON, and imported again.

For each action you can:

- add more than one key combination;
- create an all-platform binding or a macOS, Windows, Linux, or fallback
  override;
- intentionally disable the action for the selected target;
- remove an override and inherit the built-in profile again;
- review conflicts before accepting an overlapping binding.

An imported profile is schema-checked, size-limited, normalized, and rejected
if it names unknown actions or invalid/unreachable key combinations. Imported
profiles become a copy with a fresh local identity rather than overwriting an
existing profile silently.

## Context and scope

The same key may be valid in different editors. OpenStudio resolves bindings by
action scope, including global, Timeline/ruler, track controls, Mixer, Piano
Roll, Pitch Editor, automation, browser, plug-in, modal, and contextual
surfaces. Text entry and active shortcut capture take precedence so typing in a
field does not accidentally run a DAW command.

The action list is the authoritative view of the selected profile. Use
**Print** to generate a cheat sheet for the current profile and platform; static
shortcut examples in the manual show the OpenStudio default profile only.

## Mouse and wheel safety

Vendor mouse profiles enable only gestures that have a documented OpenStudio
equivalent and a valid hit target. Unsupported parameter-wheel gestures are
suppressed instead of falling through to a different OpenStudio value change.
Browser zoom protection and normal list/browser scrolling remain application
safety behavior, independent of the selected vendor profile.

Some gestures are intentionally surface-specific. Examples include Cubase
fade/event-volume adjustment, Pro Tools waveform zoom, FL Studio clip/note
operations, and Cakewalk grouped console-fader changes. A gesture that requires
a missing OpenStudio state remains unassigned rather than changing a broader
control unexpectedly.

## Verification and source notes

The implementation is covered by unit tests for platform normalization,
dispatch precedence, strict/fallback policy, conflicts, import/export,
mouse/wheel resolution, undo transactions, detached-window base-profile sync,
and editor scopes. Playwright flows cover onboarding, base-profile and custom
keyboard-profile persistence, runtime switching, custom keyboard overrides,
keyboard capture, and representative wheel behavior.

The built-in profile claims were last validated against official vendor
manuals, help pages, and shortcut sheets on **2026-08-21**. The primary source
set is:

- [Avid Pro Tools](https://kb.avid.com/pkb/articles/en_US/Knowledge/Pro-Tools-Documentation),
  [Steinberg Cubase/Nuendo](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/key_commands/key_commands_tool_category_c.html),
  [REAPER](https://dlz.reaper.fm/userguide/ReaperUserGuide779a.pdf), and
  [Audacity](https://manual.audacityteam.org/man/keyboard_shortcut_reference.html);
- [Apple Logic Pro](https://support.apple.com/en-mt/guide/logicpro/lgcp02bf31b6/mac)
  and [GarageBand](https://support.apple.com/guide/garageband/gbnd715f33a0/mac),
  [FL Studio](https://www.image-line.com/fl-studio-learning-content/fl-studio-online-manual/html/basics_shortcuts.htm),
  [Ableton Live](https://www.ableton.com/en/manual/live-keyboard-shortcuts/), and
  [Studio One](https://pae-web.presonusmusic.com/downloads/products/pdf/Studio_One_Pro_7_Key_Command_Sheet.pdf);
- [Bitwig Studio](https://www.bitwig.com/userguide/latest/the_dashboard/),
  [Reason](https://docs.reasonstudios.com/reason14/key-commands),
  [Cakewalk/Sonar](https://help.cakewalk.com/hc/en-us/articles/360036997613-Cakewalk-Sonar-Keyboard-Shortcuts),
  [Digital Performer](https://cdn-data.motu.com/manuals/software/dp/v113/Digital%20Performer%20User%20Guide.pdf),
  and [Ardour](https://manual.ardour.org/setting-up-your-system/keyboard-shortcuts/);
- [Adobe Audition](https://helpx.adobe.com/audition/desktop/keyboard-shortcuts/default-keyboard-shortcuts.html),
  [Mixcraft](https://acoustica.com/mixcraft-10-manual/keyboard-shortcuts),
  [Waveform](https://www.tracktion.com/training/manuals), and
  [Renoise](https://tutorials.renoise.com/wiki/Keyboard_Shortcuts).

These sources describe each product's **published defaults**. They are not a
promise to reproduce a user's customized source-DAW map. OpenStudio's own named
custom profiles and overrides are a separate, persisted layer on top of the
selected published-default base.
