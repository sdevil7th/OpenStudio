# Keyboard, Hotkey, Mouse, and Scroll Profiles

OpenStudio can adopt the familiar input conventions of another DAW without
changing the project or audio engine. Keyboard and mouse/scroll behavior are
separate choices: for example, you can use Cubase-style keys with REAPER-style
timeline scrolling.

## Choose a profile

1. Open **Options > Keyboard, Mouse & Trackpad** (also available in **Help**).
2. Choose a **Keyboard profile**.
3. Choose a separate **Mouse & scroll profile**.
4. Search the action list to see the effective keys and their active scope.

Use **Mouse & gestures** to inspect wheel combinations for the timeline, ruler,
Piano Roll, Pitch Editor, track headers, parameters, and selected clip handles.
Keyboard categories can be collapsed individually or together; searching reveals
matching actions even in collapsed categories. Custom profile management and
platform overrides are in a separate collapsible section.

The first-run profile card exposes both selectors; Getting Started shows the
current choices and directs you to the shortcut window. Preferences also shows the
current mouse behavior and exact modifier overrides.

The selected keyboard base, mouse/scroll base, custom keyboard profiles, and
fine-grained per-gesture mouse overrides are persisted. Named/importable custom
profiles currently apply to the keyboard only. Mouse overrides are validated
before loading and are synchronized to detached editor windows with the active
base profiles.

## Binding vocabulary

The Cubase profile maps **F6** to the track envelope panel, **Alt+R** to uniform all-track Read and **Alt+W** to uniform all-track Write (**Option** on macOS). Write enables Read; switching Write off leaves Read on, including on empty tracks. Master R/W is controlled separately. These bindings describe the development checkout and remain subject to custom overrides and editor focus.

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

The Keyboard, Mouse & Trackpad window can create named profiles on top of any built-in
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

Space in a text field belongs to text entry, including during playback or
recording. On a non-text Rack knob or slider, the effective Play binding is
reserved for transport; unbinding or remapping it releases Space back to that
control. Native plug-in editors receive keys before permitted host forwarding.
An open but unfocused editor must never claim another window's undo context.

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

## Trackpad magnification

Pinch events zoom the timeline, MIDI editor or pitch editor around the pointer.
The adapter handles Ctrl-wheel magnification and WebKit GestureEvents while
keeping physical Control-wheel available to the selected mouse profile. The
Logic Pro mouse profile retains Control-Option scrolling on macOS. Two-axis
wheel packets pan both axes in canvas editors, including horizontal scrolling
that cannot be handled by a native scrollbar. Native WKWebView and physical trackpad
qualification remain required; Chromium simulation is not a macOS device test.

Piano Roll and Pitch Editor navigation adapts the selected timeline profile:
general horizontal/vertical scrolling and zooming carry across; track-height
zoom becomes note-height zoom. Item-specific source gestures keep their own
targets. This is an OpenStudio adaptation, not a claim that each vendor uses the
same gestures in every editor. Touchscreen multi-touch navigation is not
implemented. Ctrl-wheel pinch recognition is heuristic when a WebView has not
received the physical Control keydown; line/page wheels, large notches, and
Ctrl+Shift chords are excluded from that heuristic.

## Verification and source notes

The implementation is covered by unit tests for platform normalization,
dispatch precedence, strict/fallback policy, conflicts, import/export,
mouse/wheel resolution, undo transactions, detached-window base-profile sync,
and editor scopes. Playwright flows cover onboarding, base-profile and custom
keyboard-profile persistence, runtime switching, custom keyboard overrides,
keyboard capture, and representative wheel behavior.

The previous implementation recorded the following source set on
**2026-08-21**. These references alone do not establish complete gesture parity
or real-app input coverage. The **2026-09-09** navigation audit and its actual
test boundaries are recorded in [input-profiles.md#navigation-source-references](input-profiles.md#navigation-source-references).
The earlier source set is:

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

## Navigation source references


The following is a navigation review, not a certification of every command in
the 19 profile families. Published source defaults, user-customized source
profiles, and OpenStudio adaptations are distinct.

| Profile | Source and scope reviewed | Consequence |
|---|---|---|
| Cubase / Nuendo | [Cubase 15 Project Window zoom](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/project_window/project_window_zooming_c.html) | Ctrl/Cmd-wheel horizontal and Ctrl/Cmd-Shift-wheel vertical zoom verified against documentation; H/G keyboard zoom also documented. No separate Alt-wheel zoom claim. |
| FL Studio | [Playlist manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm) | Added missing Ctrl-wheel timeline zoom. Clip nudging remains contextual, with Alt+Shift for the documented default. |
| Pro Tools | [Reference guide, scroll-wheel functions](https://resources.avid.com/SupportFiles/attach/Pro_Tools/12.6.1/Pro_Tools_Reference_Guide_12_6_1.pdf) | Historical primary reference located; current-version parity not re-certified. Existing scoped zoom/scroll mappings retained. |
| REAPER | [Official quick start](https://www.reaper.fm/guides/REAPER%20Quick%20Start.pdf) | Ctrl+Alt-wheel vertical scrolling is documented. Current 7.79 PDF could not be fetched in this audit; full version-specific parity not asserted. |
| Audacity | [Vertical zooming](https://manual.audacityteam.org/man/vertical_zooming.html) | Scale-strip zoom/pan is contextual, not a general track-height command. |
| Logic Pro | [Zoom windows](https://support.apple.com/en-mt/guide/logicpro/lgcp5cbf2096/mac) | Physical macOS Control/Option must remain distinct from Command. Source-version/hardware parity not asserted. |
| Ableton Live | [Arrangement View](https://www.ableton.com/en/live-manual/12/arrangement-view/) | Navigation and lane-height gestures are surface-dependent. General navigation is adapted for OpenStudio note editors. |
| Studio One | [Official version 7 key command sheet](https://pae-web.presonusmusic.com/downloads/products/pdf/Studio_One_Pro_7_Key_Command_Sheet.pdf) | Modified scrolling differs from Cubase; profile switching is exercised in the actual timeline. |
| Bitwig Studio | [Arrange View](https://www.bitwig.com/userguide/latest/the_arrange_view_and_tracks/) | Ctrl+Alt scrolling and trackpad pinch are documented; no claim to reproduce every configurable navigation mode. |
| Reason | [Key Commands](https://docs.reasonstudios.com/reason13/key-commands) | Sequencer modifier-wheel navigation documented; version 14 parity not re-certified here. |
| Cakewalk / Sonar | [Mouse Wheel Zoom Options](https://legacy.cakewalk.com/Documentation?help=Menus2.100.html&language=3&product=SONAR) | Zoom options are configurable; the profile represents a subset, not every preference combination. |
| GarageBand | [Mac user guide](https://support.apple.com/en-lamr/guide/garageband/welcome/mac) | No newly verified modifier-wheel override. Normal scrolling/pinch and editor fallback are OpenStudio behavior. |
| Digital Performer | [MOTU manual](https://cdn-data.motu.com/manuals/software/Digital%20Performer%20User%20Guide.pdf) | Parameter wheel behavior is configurable; the version 11.3 link could not be fetched. No complete current-version claim. |
| Ardour | [Editor preferences](https://manual.ardour.org/preferences-and-session-properties/preferences-dialog/) | Zoom anchor is configurable; OpenStudio's pointer anchoring is an adaptation, not exact default parity. |
| Adobe Audition | [Viewing, zooming, navigating](https://helpx.adobe.com/uk/audition/desktop/workspace-and-setup/viewing-zooming-navigating-audio.html) | Plain-wheel zoom belongs on the ruler; horizontal scrolling is explicitly documented. |
| Mixcraft | [Main window](https://acoustica.com/mixcraft-10-manual/mixcraft-main-window-reference), [Sound tab](https://acoustica.com/mixcraft-10-manual/sound-tab) | Wheel preferences and separate MIDI gestures exist. The generic editor adaptation does not claim complete native MIDI parity. |
| Waveform | [Official manual index](https://www.tracktion.com/training/manuals) | Version 14 manual located; not every wheel preference re-certified. |
| Renoise | [Preferences](https://tutorials.renoise.com/wiki/Preferences) | Tracker/sample-editor operations are not equivalent to timeline commands; no invented timeline modifier mappings. |
| OpenStudio | Application defaults | Native application behavior, not a vendor compatibility claim. |

## Navigation qualification

Use `tools/input-profile-browser-regression.js` in a disposable browser session
against the real App. Resolver/dispatch-table tests alone do not prove that a
Timeline, Piano Roll or Pitch Editor viewport moves. Check all profile families,
both wheel axes, modifier chords, physical Control versus pinch, profile changes,
and note-editor navigation. A canvas cannot fall back to native DOM scrolling.
Search must reveal collapsed shortcut categories; keyboard and gesture views
must preserve the selected profile. Vendor parity, physical trackpads and native
macOS/Windows input require separate qualification; touchscreen multitouch is not
implemented. Do not infer a stale-WebView cause from browser-only success.
