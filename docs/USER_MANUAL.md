# OpenStudio User Manual

Comprehensive reference for the current source checkout. Published installers
may contain fewer features; consult the [release notes](releases/) for
your application version. The signed updater and macOS/Linux replacement flow
below are implemented in this checkout but still need a new application release.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Interface Overview](#2-interface-overview)
3. [Working with Tracks](#3-working-with-tracks)
4. [Recording Audio](#4-recording-audio)
5. [Recording MIDI](#5-recording-midi)
6. [Editing](#6-editing)
7. [MIDI Editing](#7-midi-editing)
8. [Mixing](#8-mixing)
9. [Effects](#9-effects)
10. [Automation](#10-automation)
11. [Markers and Regions](#11-markers-and-regions)
12. [Rendering and Exporting](#12-rendering-and-exporting)
13. [Project Management](#13-project-management)
14. [Scripting](#14-scripting)
15. [Customization](#15-customization)
16. [Keyboard Shortcuts](#16-keyboard-shortcuts)
17. [Troubleshooting](#17-troubleshooting)
18. [AI Music and Assisted Audio](#18-ai-music-and-assisted-audio)
19. [In-app updates](#in-app-updates)
20. [File formats and upgrade compatibility](#file-formats-and-upgrade-compatibility)

---

> **Shortcut notation:** Inline shortcuts in this manual show the OpenStudio
> default keyboard and mouse profiles. The active profile, operating system,
> editor scope, and custom overrides can change them. **Help > Keyboard,
> Mouse & Trackpad** is authoritative for keys and selected base profiles; the
> fine-grained mouse-gesture overrides are shown in **Preferences > Mouse**.

## 1. Getting Started

### 1.1 System Requirements

OpenStudio is a desktop DAW built with a JUCE C++ audio backend and a React/TypeScript frontend rendered through an embedded web UI.

**Minimum requirements:**

- Windows 10 or later (64-bit), a supported macOS release, or an x86-64 Linux
  desktop with GTK 3 and WebKitGTK 4.1 (2.40 or later); use the package built
  and qualified for your distribution/version
- WebView2 Runtime on Windows (typically pre-installed on Windows 10/11)
- Audio interface with ASIO, WASAPI, or DirectSound drivers on Windows
- 4 GB RAM (8 GB or more recommended)
- Multi-core processor

**Supported audio driver types:**

| Driver Type   | Description                                      |
|---------------|--------------------------------------------------|
| ASIO          | Low-latency professional audio drivers           |
| WASAPI        | Windows Audio Session API (built-in)             |
| DirectSound   | Legacy Windows audio (higher latency)            |

### 1.2 Installation

OpenStudio production releases are distributed as platform-specific install packages.

1. Download the latest Windows installer, macOS package, or Linux AppImage from the official download page.
2. Run the installer and complete the setup steps for your platform.
3. Launch OpenStudio from the Start menu, Applications folder, or desktop shortcut.

**Windows:** run the installer and follow the wizard. If you are using the unsigned zero-cost release path, Windows SmartScreen may warn before first launch.

If startup reports that the embedded browser is unavailable, **Repair Dependencies** waits for the bundled prerequisite installers and checks browser availability again. If it still fails, open the startup log from the recovery screen and include its WebView2 error details when reporting the problem.

**macOS:** OpenStudio v1 ships as an unsigned DMG. Drag `OpenStudio.app` to `Applications`. If macOS blocks launch, right-click the app, choose **Open**, and if needed allow it under **System Settings > Privacy & Security**.

**Linux:** mark the downloaded AppImage executable and launch it from your
desktop or terminal. FFmpeg-backed operations use an optional system `ffmpeg`
on `PATH`; the AppImage does not bundle an arbitrary host FFmpeg binary.
Launch the AppImage file itself; copying only its internal `OpenStudio` executable
leaves out the `webui`, effects, and script assets it needs to start.

**Linux native installers (development candidate, not yet publicly released):**
Ubuntu, Debian and Mint use `.deb`; Fedora uses `.rpm`. Open the matching package
with the desktop software installer, approve normal administrator authentication,
then launch **OpenStudio** from the application menu. The package manager installs
runtime dependencies, including FFmpeg and credential-storage tools. Development
headers are not required. Native-package updates use the matching package again;
**Help > Check for Updates...** links to the download page. Do not run the app as root.

If double-clicking a `.deb` opens **Archive Manager**, close that window; do not
extract the package. In Files, right-click the downloaded `.deb`, choose **Open
With Other Application**, select **Software Install**, then click **Select**.
Click **Install** and authenticate when prompted. To make future double-clicks
use the installer, open the file's **Properties > Open With**, select **Software
Install**, and choose **Set as default**. Labels vary by desktop; Debian may call
the application **Software**, and Mint uses **Package Installer**. If no package
installer appears, it must first be installed through the distribution's software
center. This one-time desktop setup is part of the supported installation guidance.

To upgrade, open the newer matching package and complete its Install/Upgrade
action; uninstalling first is unnecessary. To remove OpenStudio, find it under
the software center's installed applications and choose **Uninstall** or the
trash button. On Debian/Ubuntu/Mint, `sudo apt remove openstudio` is an alternative;
this removes the application rather than projects saved in your home directory.

Qualification is in progress. Earlier revision 5 passed installed native checks in
Ubuntu 22.04, Debian 13, Fedora 44 and a Mint 22.3 live session, with the exact
desktop and lifecycle limits recorded in the
[Linux installation and qualification plan](linux-installation-and-qualification-plan.md).
Those are historical checkpoints. The integrated PR 26 source and current test
scope are recorded in the [October 7 qualification report](linux-pr26-qualification.md).

OpenStudio also includes automatic update checks. Open **Help > Check for
Updates...** to check immediately and choose when to download/install. See
[in-app updates](#in-app-updates) for platform requirements and older-client migration.

Stem separation uses optional AI Tools that are installed separately from the base app. If AI Tools are missing, use the **AI Tools** button beside the Settings button or the **Install AI Tools** button inside the Stem Separation dialog.

On first launch, OpenStudio will:
- Create default configuration files in the application data directory.
- Scan for available audio devices and drivers.
- Present the default project with an empty timeline.

### 1.3 First Launch and Audio Setup

When you first open OpenStudio, you should configure your audio settings:

1. Open the Audio Settings dialog:
   - Go to **View > Audio Settings...** in the menu bar, or
   - Click the **gear icon** in the Main Toolbar.
2. Select your preferred **Audio System** (ASIO on Windows; ALSA or a configured JACK service on Linux).
3. If using ASIO, select your **ASIO Driver** from the dropdown.
4. For other audio systems, select your **Input Device** and **Output Device**.
5. Choose a **Sample Rate** (44100 Hz or 48000 Hz are standard).
6. Set a **Buffer Size** (lower values reduce latency but increase CPU load; 256 or 512 samples is a good starting point).
7. Click **Apply** to activate the settings and inspect the accepted values without
   closing the dialog, or **OK** to apply and close it.

In the development checkout, changing the audio system, WASAPI **Mode**, or
input/output device refreshes the reported choices and selects the new device's
reported default rate and preferred buffer size in the open dialog; adjustments appear above the controls. Changing a rate
or buffer also revalidates the pending selection. **Cancel**, Escape, and the
close button discard unapplied changes; selecting an audio system no longer
activates it immediately.

Inactive ASIO drivers are inspected for rates, buffer limits and preferred
settings without opening an audio stream. Small buffers such as 8 and 16 samples
appear when reported by that driver. An unavailable driver shows an error instead
of fabricated options. Rate-dependent restrictions are verified by the driver at
Apply; the displayed applied values reflect what it accepted. WASAPI Shared,
Exclusive, and Shared Low Latency remain subject to the selected device's limits.
These development changes have not yet been qualified on all hardware/platforms.

**Linux audio (working-tree candidate):** switching audio systems selects that
system's default devices. A failed switch displays the driver error and restores
the previous setup where possible. JACK requires a running JACK server or
configured PipeWire JACK compatibility; installing the JACK client library alone
is insufficient. ALSA can list both direct hardware devices and desktop-server
routes for the same interface.

For the Audient iD14 MKII, the direct ALSA entry on the qualification machine is
**Audient iD14, USB Audio; Direct hardware device without any conversions**.
Select it for both input and output, start at 48 kHz / 512 samples, and route a
mono audio track to Input 1 or Input 2. Arm that track to record; enable its input
monitoring when software monitoring is wanted. Hardware minimum channel counts
may activate all 12 capture and 6 playback channels even when only the first two
are routed. Ten-second writer/device captures passed at 44.1/48 kHz on Ubuntu
26.04; installed track routing, listening, latency and sustained operation are
still qualification gates. An application holding the device may prevent another
application from opening the direct hardware route.

### 1.4 Creating Your First Project

After configuring audio, you are ready to begin:

1. The application starts with a new, empty project.
2. Add your first track:
   - Press `Ctrl+T` to add an audio track, or
   - Press `Ctrl+Shift+T` to add a MIDI track.
3. Import audio:
   - Go to **File > Import > Audio...** (`Ctrl+I` in the OpenStudio profile), or
     **File > Import > MIDI...** (`Ctrl+Alt+I`). **Insert > Media file...** (`Insert`)
     accepts both, plus supported video containers.
   - Select one or more files. A single file uses a compatible selected track;
     otherwise a new track is created. Multiple files create separate tracks at
     the cursor position captured when you opened the chooser. Each file import
     is undoable. MIDI currently combines source MIDI tracks into one clip per file.
   - Import references source audio files; it does not copy them into the project.
     Keyboard profiles and custom shortcuts can change or unbind these defaults.
4. Press `Space` to play back.
5. Save your project with `Ctrl+S` (project files use the `.osproj` extension).

### 1.5 Project File Format

OpenStudio projects are saved as `.osproj` files. These contain:

- Track layout and properties (names, colors, types, volume, pan, solo, mute, armed state)
- Clip references (file paths, positions, durations, offsets, fades, volume)
- MIDI clip data (note events, CC events)
- Automation lanes and points
- Markers and regions
- Tempo map and time signature information
- Mixer state (sends, FX chains)
- Plugin state (FX presets and parameters)
- Project settings (BPM, time signature, grid size, snap mode)

Audio files are stored externally and referenced by path. Moving or deleting source audio files may cause missing media errors.

---

## 2. Interface Overview

OpenStudio's interface follows a professional DAW layout with the following main areas arranged from top to bottom:

```text
+--------------------------------------------------+
|  Menu Bar (File, Edit, View, Insert, Options, Help) |
+--------------------------------------------------+
|  Main Toolbar (Transport, Tools, View Toggles)    |
+--------------------------------------------------+
|  Track Control Panel  |  Timeline / Arrange View  |
|  (Track Headers)      |  (Waveforms, Clips, Ruler)|
+--------------------------------------------------+
|  Mixer Panel (when visible)                       |
+--------------------------------------------------+
|  Transport Bar (Time, Status, Controls, BPM)      |
+--------------------------------------------------+
```

### 2.1 Menu Bar

The Menu Bar runs along the top of the window and doubles as the title bar (drag empty space to move the window). It contains:

| Menu      | Purpose                                                                   |
|-----------|---------------------------------------------------------------------------|
| **File**  | New/Open/Save projects, templates, render, export, archive, media pool    |
| **Edit**  | Undo/Redo, cut/copy/paste, select all, split, group/ungroup, time ops    |
| **View**  | Toggle panels (Mixer, Keyboard, Undo History), zoom, screensets, grid     |
| **Insert**| Add tracks, media files, markers, regions, empty items, MIDI clips        |
| **Options**| Record mode, ripple editing, locking, themes, preferences                |
| **Help**  | Getting Started Guide, Help Reference, Keyboard, Mouse & Trackpad, updates, About |

The right side of the Menu Bar contains standard window controls: Minimize, Maximize/Restore, and Close.

### 2.2 Main Toolbar

The Main Toolbar sits below the Menu Bar and provides quick access to commonly used functions, organized into groups separated by vertical dividers:

**Transport Controls:**
- Loop toggle (purple)
- Record (red, active when recording, disabled if no tracks are armed)
- Play (green)
- Stop
- These duplicate the controls in the Transport Bar for convenience.

**Edit Tools:**
- Undo / Redo
- Snap to Grid toggle
- Auto-Crossfade toggle

**Tool Mode:**
| Tool       | Key | Description                                              |
|------------|-----|----------------------------------------------------------|
| Select     | `V` | Default mode for selecting, moving, and resizing clips   |
| Split      | `B` | Click on a clip to split it at that point                |
| Mute       | `X` | Click on a clip to toggle its mute state                 |
| Smart      | `Y` | Context-sensitive tool that auto-switches between move, trim, and fade based on cursor position |

**View Toggles:**
- Mixer panel toggle (`Ctrl+M`)
- AI Tools button for optional stem-separation runtime install/status
- Audio Settings (gear icon)

### 2.3 Track Control Panel (TCP)

The Track Control Panel occupies the left side of the workspace. Each track has a header displaying:

- **Color bar**: Click to open the color picker and assign a custom track color.
- **Track name**: Double-click to rename. Shows track icon if assigned.
- **Record Arm button** (circle icon): Enables recording on this track.
- **Mute button** (M): Silences the track output.
- **Solo button** (S): Solos the track (mutes all non-soloed tracks).
- **FX button**: Opens the FX Chain panel. Glows green when effects are loaded, red when bypassed.
- **FX Bypass button**: Quickly bypass/enable all effects on the track.
- **Volume knob**: Adjust track volume in dB (range: -60 dB to +12 dB).
- **Pan knob**: Adjust stereo panning (L100 to R100, center at C).
- **Input selector**: Choose the audio input channel(s) for recording (stereo or mono pairs).
- **Input type toggle**: Switch between stereo and mono input modes.
- **Activity indicator**: Mini meter bar showing current signal level.
- **Track notes**: Click the sticky note icon to add text notes to a track.

**Track Groups**: Tracks that belong to a group display a colored indicator matching the group color.

**Folder Tracks**: Folder tracks show a collapse/expand chevron to hide or show their child tracks. Nested tracks are indented to indicate hierarchy.

**Master Track in TCP**: The master track can optionally be shown in the TCP via **View > Show Master Track in TCP**.

### 2.4 Timeline / Arrange View

The Timeline is the central canvas-based workspace where you arrange audio and MIDI clips. It is rendered using the Konva library for high-performance canvas drawing.

**Key elements:**

- **Ruler**: Displays time positions at the top. Shows bars/beats or time depending on grid settings. Click the ruler to move the playhead.
- **Playhead**: A vertical line indicating the current playback/edit position. The red line moves during playback.
- **Clips**: Rectangular blocks representing audio or MIDI data. Each clip displays:
  - The clip name
  - Waveform visualization (for audio clips)
  - MIDI note visualization (for MIDI clips)
  - Fade-in and fade-out handles at the top corners
  - Trim handles on the left and right edges (in Select or Smart tool mode)
- **Grid lines**: Vertical lines aligned to the current grid setting (bar, beat, subdivision).
- **Automation lanes**: Per-track lanes below the track that display automation curves.
- **Time selection**: A highlighted region created with Primary+drag on the timeline background or Shift+drag on the ruler (`Primary` is Ctrl on Windows/Linux and Command on macOS).
- **Razor edits**: Semi-transparent selection areas created with Alt/Option+drag on the timeline background for precise non-destructive editing.

**Essential Navigation:**
- **Scroll**: native vertical scrolling through the workspace.
- **Ctrl+Scroll**: horizontal timeline zoom around the mouse pointer.
- **Shift+Scroll**: horizontal timeline scroll.
- **Alt+Scroll**: track height resize.
- **Ctrl+Shift+Scroll**: waveform-height zoom for the hovered track.
- **First-session hotkeys**: `Space`, `Ctrl+R`, `Ctrl+T`, `Ctrl+M`, `S`, `B`, `Delete`, `Ctrl+S`, `F1`, `Ctrl+Shift+P`.
- **Need a refresher?** Press `F1` for the searchable **Help Reference** and open **Help > Keyboard, Mouse & Trackpad** for the full shortcut list and custom scoped rebinding.

**Zoom and Scroll:**
- **Horizontal zoom**: `Ctrl+Scroll wheel` (or `Ctrl++` / `Ctrl+-`). Zoom range: 1 to 1000 pixels per second.
- **Playhead visibility**: the ruler marker and vertical line update together after zoom, scroll, or resize, including while stopped, whenever the playhead lies within the visible time range.
- **Horizontal scroll**: Shift+scroll wheel, or use the horizontal scrollbar.
- **Vertical scroll**: Scroll wheel when hovering over the track area.
- **Zoom to Fit**: `Ctrl+0` resets zoom to a standard overview level.
- **Zoom to Time Selection**: `Ctrl+Shift+E` zooms the view to fit the current time selection.
- **Crosshair cursor**: Toggle via View menu for precise positioning guidance.

### 2.5 Transport Bar

The Transport Bar runs along the bottom of the window and provides:

**Left Section - Time Display:**
- Current playhead position displayed in one of three modes (click to cycle):
  - **Time mode** (green): `MM:SS.mmm` format
  - **Beats mode** (blue): `BAR.BEAT.TICK` format
  - **SMPTE mode** (amber): `HH:MM:SS:FF` format (frame rate configurable)
- Transport status indicator: `[Playing]`, `[Recording]`, `[Paused]`, or `[Stopped]`
- Record mode indicator (when not Normal): Shows `OVERDUB` or `REPLACE` badge
- Ripple mode indicator (when active): Shows `Ripple: Track` or `Ripple: All`

**Center Section - Transport Controls:**
- **Go to Start** (skip back icon): Returns the playhead to the beginning.
- **Record** (red circle): Starts recording on armed tracks. `Ctrl+R`
- **Play / Pause** (green triangle): Starts or pauses playback. The default `Space` shortcut starts or stops transport, including an active recording.
- **Stop** (square): Stops playback or recording. There is no separate default keyboard shortcut.
- **Pause** (parallel bars): Pauses playback in place.
- **Loop** (repeat icon): Toggles loop playback mode. `L`
- **Metronome** (metronome icon): Toggles metronome **Enable**. `K`

**Right Section - Project Info:**
- **Time Signature** input: Click to change numerator/denominator (e.g., 4/4, 3/4, 6/8).
- **Metronome Settings** (gear icon): Opens metronome configuration (sound, accent pattern, volume).
- **BPM** input: Type a new tempo value (range: 10-300 BPM). Press Enter or click away to apply.
- **TAP** button: Tap repeatedly to set tempo by feel. Also available via `T` key.

**Click-only practice:** use **Play click only / Stop click only** in Metronome
Settings, or press **Ctrl+Shift+Space** on Windows/Linux and **Cmd+Shift+Space** on
macOS. This shortcut is available in all 19 built-in keyboard profiles, works with
the dialog closed, and can be reassigned or disabled in **Keyboard, Mouse &
Trackpad**. While transport is stopped, the click plays with live input monitoring;
clips do not play and the playhead stays parked. During Play/Record, the click follows
transport and standalone practice can resume when transport stops. **Stop click
only** stops standalone practice; if **Enable** is on, the transport-driven click
can still sound during playback or recording. Sound, accent, volume, and
render-as-track controls share the same settings.

**Click sounds** starts collapsed. Expand it to choose **Electronic (original)**,
**Woodblock**, **808-style cowbell**, or **Mechanical tick** independently for Regular and
Accent. **Play click only** auditions the current pair without moving the playhead.
The cowbell is an electronic drum-machine sound; its accent is a stronger strike
at the same pitch. Use a custom sample for an acoustic cowbell sound.
**Choose file…** accepts WAV, AIFF, FLAC or Ogg. Use one sharp hit: the first two
seconds are inspected, DC offset is removed, and the strongest channel is used
to avoid stereo cancellation. The first attack peak is aligned to 1 ms after the
beat, its peak level is matched, and its tail fades to at most 100 ms. Silent,
clipped, non-finite, slow-attack and detectable multiple-hit samples are rejected;
the previous sound stays selected. Automatic detection cannot guarantee that
every noisy or complex recording is a suitable click, so audition imported pairs.

Prepared copies are kept in the app-data **MetronomeSounds** folder. Project
save/load preserves the selections; old projects use the original sounds. Moving
the original upload does not break the prepared copy. When transferring a project
to another computer, include its prepared click files; missing copies produce a
warning and fall back to the original electronic sound. Existing rendered click
tracks must be regenerated to pick up a changed sound.

### 2.6 Mixer Panel

The Mixer Panel appears at the bottom of the workspace when toggled (`Ctrl+M`). It provides a horizontal mixer console layout.

**Header:**
- "Mixer" label
- Close button

**Mixer Snapshots Toolbar:**
- Named snapshot buttons: Click to recall a previously saved mixer state.
- Delete button (trash icon) next to each snapshot.
- **Save** button: Saves the current mixer state as a new named snapshot.

**Channel Strips:**
- The **Master** channel strip is fixed on the left, separated by a divider.
- Track channel strips follow in order. They can be reordered via drag-and-drop.
- Each strip shows: track name, volume fader, pan knob, solo/mute buttons, record arm, FX indicator, peak meter, and gain staging display.

For detailed mixer usage, see [Section 8: Mixing](#8-mixing).

### 2.7 Additional Panels

OpenStudio includes several additional panels accessible via the View menu:

| Panel                    | Access                  | Description                                    |
|--------------------------|-------------------------|------------------------------------------------|
| Virtual MIDI Keyboard    | `Alt+B`                 | 88-key on-screen MIDI keyboard                 |
| Undo History             | `Ctrl+Alt+Z`            | Scrollable history of all undo/redo actions     |
| Region/Marker Manager    | View menu               | List and manage all markers and regions         |
| Clip Properties          | `F2`                    | Detailed properties of the selected clip        |
| Big Clock                | View menu               | Large timecode display                          |
| Render Queue             | View menu               | Queue and manage multiple render jobs           |
| Routing Matrix           | View menu               | Visual signal routing between tracks/buses      |
| Media Explorer           | View menu               | Browse/import media; backend audio preview is partial |
| Media Pool               | View menu               | State/actions exist; the full panel is not mounted yet |
| Loudness Meter           | View > Metering         | LUFS loudness measurement                       |
| Spectrum Analyzer        | View > Metering         | Frequency spectrum display                      |
| Phase Correlation Meter  | View > Metering         | Stereo phase correlation                        |
| Video Window             | View menu               | Video playback for scoring to picture           |
| Script Editor            | View menu               | Lua scripting environment                       |
| Toolbar Editor           | View menu               | Customize toolbar layout                        |
| Command Palette          | `Ctrl+Shift+P`          | Fuzzy search for any action in the application  |
| Help Reference           | `F1`                    | Searchable in-app reference for controls and features |
| Keyboard, Mouse & Trackpad | Help menu               | Searchable reference, input profiles, and custom scoped rebinding |

---

## 3. Working with Tracks

### 3.1 Track Types

OpenStudio supports several track types:

| Type        | Description                                                      |
|-------------|------------------------------------------------------------------|
| **Audio**   | Records and plays back audio files. Supports stereo/mono input.  |
| **MIDI**    | Records and plays back MIDI data. No audio processing.           |
| **Instrument** | MIDI track with a virtual instrument (VSTi) plugin loaded.    |
| **Bus/Group** | Receives audio from track sends. Used for submixing, parallel processing, and effects returns. |
| **Folder**  | Organizational container that can hold other tracks. Does not carry audio. |

### 3.2 Creating Tracks

There are several ways to add tracks:

| Method                          | Shortcut/Action                                        |
|---------------------------------|--------------------------------------------------------|
| New Audio Track                 | `Ctrl+T` or Insert > New Audio Track                   |
| New MIDI Track                  | `Ctrl+Shift+T` or Insert > New MIDI Track              |
| Virtual Instrument on New Track | Insert > Virtual Instrument on New Track...             |
| Quick Add Instrument Track      | `Ctrl+Shift+I`                                         |
| New Bus/Group Track             | Insert > New Bus/Group Track                           |
| New Folder Track                | Insert > New Folder Track                              |
| Create Bus from Selected Tracks | Insert > Create Bus from Selected Tracks               |
| Insert Multiple Tracks          | Insert > Insert Multiple Tracks...                     |

When creating an Instrument track, the Plugin Browser automatically opens so you can select a virtual instrument (VST3).

### 3.3 Selecting Tracks

- **Single select**: Click on a track header in the TCP.
- **Add to selection**: `Ctrl+Click` on additional track headers.
- **Range select**: `Shift+Click` to select all tracks between the last selected track and the clicked track.
- **Select all**: `Ctrl+A`
- **Deselect all**: `Esc` or click empty space in the TCP or Mixer.

### 3.4 Renaming Tracks

1. Double-click on the track name in the Track Header.
2. Type the new name.
3. Press `Enter` or click away to confirm.

### 3.5 Reordering Tracks

Tracks can be reordered by drag-and-drop in both the Track Control Panel and the Mixer:

1. Hover over the drag handle on the track header (the grip dots area).
2. Click and drag the track to the desired position.
3. Release to drop.

Track reordering can also be done via Lua scripting using `openstudio.reorderTrack(fromIndex, toIndex)`.

### 3.6 Track Colors

Each track can be assigned a custom color:

1. Click the colored vertical bar on the left edge of the track header.
2. Select a color from the palette.
3. The color is applied to the track header, timeline clips, and mixer channel strip.

You can also set track colors via the right-click context menu on a track header.

### 3.7 Track Properties

Each track has the following configurable properties:

| Property          | Description                                                          |
|-------------------|----------------------------------------------------------------------|
| Name              | Display name of the track                                            |
| Color             | Visual color for identification                                      |
| Volume            | Output level in dB (-60 to +12 dB)                                  |
| Pan               | Stereo position (-1.0 left to +1.0 right)                           |
| Mute              | Silences the track output                                            |
| Solo              | Isolates the track (mutes all non-soloed tracks)                     |
| Record Arm        | Enables recording on the track                                      |
| Record Safe       | Prevents accidental recording on the track                           |
| Monitor           | Enables input monitoring (hear live input)                           |
| Input Channel     | Which audio input channels to use for recording                      |
| FX Bypass         | Bypasses all effects on the track                                    |
| Frozen            | Freezes the track (renders FX to audio for CPU savings)              |
| Icon              | Custom icon displayed next to the track name                         |
| Notes             | Free-text notes attached to the track                                |

### 3.8 Track Context Menu

Right-click on a track header to access:

- Rename
- Set track color
- Duplicate track
- Remove track
- Add to folder
- Remove from folder
- Track type conversion
- Create group from selection (when multiple tracks selected)
- Solo/Mute/Arm operations

### 3.9 Deleting Tracks

- Select one or more tracks, then press `Delete`.
- Or right-click a track and choose "Remove Track".
- Deleting tracks is undoable with `Ctrl+Z`.

### 3.10 Folder Tracks

Folder tracks provide hierarchical organization:

1. Create a folder track via **Insert > New Folder Track**.
2. Move tracks into the folder:
   - Right-click a track > "Move to Folder" > select the target folder.
   - Or select tracks and use the context menu "Move Selected to Folder".
3. Click the folder's expand/collapse chevron to show or hide child tracks.
4. Folder nesting is supported (folders inside folders). Child tracks are visually indented.

### 3.11 Track Groups

Track groups link multiple tracks so that adjusting one parameter on any member affects all members. This is useful for drum submixes, orchestral sections, or any scenario where multiple tracks should move together.

**Creating a group:**
1. Select multiple tracks (`Ctrl+Click` or `Shift+Click`).
2. Right-click and choose "Create Group from Selected" or use **Insert > Create Bus from Selected Tracks**.
3. The group is assigned a unique color indicator.

**Linked parameters:**
- Volume (relative offset maintained)
- Pan
- Mute
- Solo
- Record Arm
- FX Bypass

**Managing groups:**
- View group membership in the Channel Strip context menu.
- Remove tracks from a group via context menu.
- Delete an entire group via context menu.
- Adjust which parameters are linked via group settings.

### 3.12 VCA Faders

VCA (Voltage Controlled Amplifier) style grouping allows controlling the volume of multiple tracks from a single fader without creating a submix bus. When you adjust a VCA fader, the linked tracks' volumes change proportionally, maintaining relative levels.

### 3.13 Track Freeze

Freezing a track renders all its effects to a temporary audio file, reducing CPU load while preserving the ability to unfreeze later:

1. Right-click a track > "Freeze Track" or use `openstudio.freezeTrack(trackId)` in Lua.
2. The track's FX chain is rendered offline and the frozen audio replaces live processing.
3. The frozen indicator appears on the track.
4. To restore: right-click > "Unfreeze Track" or `openstudio.unfreezeTrack(trackId)`.

### 3.14 Track Spacers

For visual organization, you can insert empty spacer rows between tracks:

- **Insert > Track Spacer Below**: Adds a visual spacer below the selected track.
- Spacers do not carry audio and serve only as visual separators.

---

## 4. Recording Audio

### 4.1 Setting Up Inputs

Before recording, configure your audio inputs:

1. Open **Audio Settings** (View > Audio Settings...) and verify your audio device is selected.
2. On each track you want to record:
   - Select the input source using the input dropdown in the Track Header.
   - Choose between **Stereo** (paired channels) or **Mono** (single channel) input mode.
   - Available inputs are determined by your audio interface's channel count.

### 4.2 Arming Tracks for Recording

- Click the **Record Arm** button (red circle) on each track you want to record.
- A track must be armed before recording can begin.
- The Record button in the Transport Bar will be disabled if no tracks are armed.
- Multiple tracks can be armed simultaneously for multi-track recording.

### 4.3 Input Monitoring

When a track is armed, you can enable input monitoring to hear the live signal:

- Toggle the **Monitor** button on the track header.
- When monitoring is enabled, the input signal passes through the track's FX chain (including input FX and track FX) and is routed to the output.
- Monitoring latency depends on your buffer size setting.

### 4.4 Recording

1. Arm the desired track(s).
2. Position the playhead where you want recording to begin.
3. Press the **Record** button in the Transport Bar or press `Ctrl+R`.
4. The transport status changes to `[Recording]` and a red dot indicator appears.
5. Perform your recording.
6. Press `Space` or the **Stop** button to end recording.
7. A new clip appears on the timeline representing the recorded audio.

Recorded audio files are saved as WAV files in the project directory.

### 4.5 Record Modes

OpenStudio offers three record modes, configurable via **Options > Record Mode**:

| Mode        | Behavior                                                              |
|-------------|-----------------------------------------------------------------------|
| **Normal**  | Creates a new clip on the armed track. Existing clips are preserved.  |
| **Overdub** | Records a new layer (take) over existing clips. Both are preserved for comping. |
| **Replace** | Replaces existing audio in the recording range with new material.     |

The current record mode is displayed as a badge in the Transport Bar when not set to Normal.

### 4.6 Punch In/Out

Punch recording allows you to record only within a specific time range:

1. Set a **loop region** or **time selection** covering the desired punch range.
2. Enable **Loop** mode (`L`).
3. Arm the track and start recording.
4. Recording will only capture audio within the loop/selection boundaries.
5. Playback continues outside the punch range without recording.

### 4.7 Takes and Comping

When recording in Overdub mode, each recording pass creates a new **take** associated with the same clip position:

**Managing takes:**
- Each clip can have multiple takes stored.
- Switch between takes by selecting the active take from the clip's take menu.
- The currently active take is the one that plays back.

**Comping workflow:**
1. Record multiple takes over the same section.
2. Use **Edit > Explode Takes to New Tracks** to spread takes across separate tracks for comparison.
3. Use **Edit > Implode Clips into Takes** to collapse selected clips back into a single clip with multiple takes.
4. Use razor editing or split tools to select the best portions from different takes.

**Keyboard shortcuts:**
- Explode Takes: available via Edit menu or Command Palette.
- Implode Takes: available via Edit menu or Command Palette.

---

## 5. Recording MIDI

### 5.1 MIDI Device Setup

OpenStudio automatically detects connected MIDI devices:

- MIDI devices are listed in the Track Header's MIDI input selector.
- Select a MIDI device from the dropdown on a MIDI or Instrument track.
- Available devices can be queried via Lua: `openstudio.getMIDIDevices()`.

Track Routing > MIDI hardware output > Same-key overlap defaults to Raw note messages. Merge overlapping keys sends the first note-on and last note-off for each channel/key, suppressing intermediate retriggers. Changes take effect after held keys are released. This setting is saved with the track and supports Undo/Redo. It affects one track's hardware output; use separate MIDI channels for independent tracks sharing a receiver. Controllers and aftertouch pass through. Relative RPN reconstruction without a known absolute baseline is skipped rather than inventing receiver state.

If the hardware MIDI queue loses messages, the sender discards the compromised backlog, releases sustain/sostenuto and notes on channels used by that track, resets overlap ownership, then resumes fresh events. Disconnecting or removing the track also releases its used channels. The routing window reports dropped messages, recovery resets and oversized messages; counts are temporary and reset when the track processor is recreated. Use separate channels for tracks sharing a receiver: channel-wide recovery can stop other voices using that same channel. This prevents retaining known stale ownership after a queue loss; it cannot restore discarded performance events or guarantee a device/driver response.


### 5.2 Recording MIDI

1. Create a MIDI track (`Ctrl+Shift+T`) or an Instrument track (`Ctrl+Shift+I`).
2. If using an Instrument track, select a virtual instrument via the Plugin Browser.
3. Select your MIDI input device on the track.
4. Arm the track for recording.
5. Enable monitoring to hear the instrument while playing.
6. Press Record (`Ctrl+R`) and play your MIDI controller.
7. Press Stop when finished.
8. A MIDI clip appears on the timeline containing the recorded note and CC data.

### 5.3 Step Input

Step input allows you to enter MIDI notes one at a time using your computer keyboard, rather than playing in real-time:

1. Open the Piano Roll for a MIDI clip (double-click the clip).
2. Enable **Step Input** mode in the Piano Roll toolbar.
3. Select the **step size** (1/4, 1/8, 1/16, or 1/32 note).
4. Set the **octave** for keyboard input.
5. Press letter keys (`C`, `D`, `E`, `F`, `G`, `A`, `B`) to insert notes.
6. The cursor advances by the step size after each note.

### 5.4 Virtual MIDI Keyboard

OpenStudio includes an 88-key on-screen MIDI keyboard:

- Toggle with `Alt+B` or **View > Show Virtual MIDI Keyboard**.
- Click keys to send MIDI notes to the selected MIDI/Instrument track.
- Useful when you do not have a physical MIDI controller.

### 5.5 MIDI Learn

MIDI Learn allows you to map physical MIDI controller knobs, faders, and buttons to OpenStudio parameters:

1. Right-click a parameter (e.g., a track fader or plugin knob).
2. Select "MIDI Learn" from the context menu.
3. Move the desired knob or fader on your MIDI controller.
4. The mapping is established and the physical control now adjusts the parameter.

---

## 6. Editing

### 6.1 Selection

**Clip selection:**
- Click a clip to select it.
- Primary+click to add/remove a clip from the selection (`Primary` is Ctrl on Windows/Linux and Command on macOS).
- Plain-drag empty timeline space to marquee-select every audio or MIDI clip intersecting the rectangle.
- Click empty timeline background to deselect all clips.
- `Ctrl+Shift+A` to select all clips.
- `Esc` to deselect all.

**Track selection:**
- Click a track header to select it.
- `Ctrl+Click` for multi-select.
- `Shift+Click` for range select.
- `Ctrl+A` to select all tracks.

**Time selection:**
- Primary+drag on the timeline background, or Shift+drag on the ruler, to create a time selection (`Primary` is Ctrl on Windows/Linux and Command on macOS).
- The time selection is highlighted as a shaded region.
- Time selections are used for punch recording, rendering bounds, and editing operations.

### 6.2 Moving Clips

- Click and drag a clip to move it to a new position or track.
- A click selects without moving or trimming the clip, even when it is off-grid. Small pointer movements below four screen pixels also count as a click.
- When snap is enabled, the clip snaps to grid lines.
- Hold `Primary` while dragging to copy the clip instead of moving it.
- Hold `Shift` while dragging to lock movement to the first axis that crosses the drag threshold.
- Hold `Alt`/`Option` while dragging to bypass snapping.
- Multi-selected clips move together as a group.

### 6.3 Splitting Clips

Split a clip into two separate clips at a specific point:

- **At playhead**: Select a clip and press `S`, or use **Edit > Split at Cursor**.
- **Using Split Tool**: Press `B` to activate the Split Tool, then click on a clip where you want to split.
- **At time selection**: Use **Edit > Split at Time Selection** to split all clips at the time selection boundaries.

Split operations are undoable with `Ctrl+Z`.

### 6.4 Trimming Clips

Trim the start or end of a clip to reveal or hide content:

1. Hover over the left or right edge of a clip in Select tool mode (cursor changes to a resize arrow).
2. Click and drag the edge inward to shorten the clip, or outward to extend it (revealing previously trimmed content).
3. If snap is enabled, the trim point snaps to the grid.

**Note**: Trimming is non-destructive. The original audio data is preserved; only the visible portion changes.

### 6.5 Slip Editing

Slip editing moves the audio content within a clip without changing the clip's position on the timeline:

1. Hold `Primary+Shift` and drag within a clip (`Primary` is Ctrl on Windows/Linux and Command on macOS).
2. The clip's boundaries stay fixed, but the audio content slides earlier or later within the clip.
3. This is useful for adjusting the timing of audio relative to the clip boundaries.

### 6.6 Fade In/Fade Out

Each clip has adjustable fade-in and fade-out regions:

1. Hover over the top-left corner of a clip to see the fade-in handle.
2. Hover over the top-right corner to see the fade-out handle.
3. Drag the handle inward to create or extend the fade.
4. The fade is displayed as a curved line on the clip.

**Auto-Crossfade**: When enabled (toggle in Main Toolbar or View menu), overlapping clips on the same track automatically create crossfades.

For an audio clip's gain envelope, Shift+click the clip to add a point. Drag an
existing point to change its time and gain; right-click a point to remove it.

### 6.7 Undo and Redo

OpenStudio provides comprehensive undo/redo support for virtually all editing operations:

- **Undo**: `Ctrl+Z`
- **Redo**: `Ctrl+Shift+Z`

The undo history can be viewed via **View > Undo History** (`Ctrl+Alt+Z`), which shows a scrollable list of all operations. Click any item in the history to jump to that state.

Operations tracked by undo include:
- Adding, removing, moving, splitting, resizing clips
- Changing clip properties (volume, pan, fades, color, mute, lock, group, reverse)
- Paste, nudge, quantize, normalize operations
- Time selection operations (cut, delete, insert silence)
- Razor edit content deletion
- Track property changes (name, color, volume, pan, mute, solo, armed)

### 6.8 Clipboard Operations

| Operation | Shortcut   | Description                              |
|-----------|------------|------------------------------------------|
| Cut       | `Ctrl+X`   | Remove selected clips and place on clipboard |
| Copy      | `Ctrl+C`   | Copy selected clips to clipboard          |
| Paste     | `Ctrl+V`   | Paste clips from clipboard at playhead    |

Clipboard operations support:
- Single clip copy/paste
- Multi-clip copy/paste (preserves relative track positions)
- Copy/Cut within time selection

### 6.9 Nudging Clips

Move selected clips by small increments:

| Action          | Shortcut     | Description                    |
|-----------------|--------------|--------------------------------|
| Nudge Left      | `Left`       | Move clip(s) left by grid unit |
| Nudge Right     | `Right`      | Move clip(s) right by grid unit|
| Nudge Left Fine | `Ctrl+Left`  | Move clip(s) left by fine amount |
| Nudge Right Fine| `Ctrl+Right` | Move clip(s) right by fine amount |

### 6.10 Time Selection Operations

When a time selection is active, the following operations are available:

| Operation                      | Description                                          |
|--------------------------------|------------------------------------------------------|
| Cut within Time Selection      | Removes content in the time selection from all tracks |
| Copy within Time Selection     | Copies content within the time selection              |
| Delete within Time Selection   | Deletes content and ripples subsequent clips earlier  |
| Insert Silence                 | Inserts silence at the time selection, pushing content later |
| Split at Time Selection        | Splits all clips at both edges of the time selection  |
| Set Loop to Selection          | Sets the loop region to match the time selection (`Ctrl+L`) |

### 6.11 Razor Editing

Razor editing provides a fast way to select and delete specific regions across multiple tracks:

1. Hold `Alt`/`Option` and drag on the timeline background to create a razor selection area.
2. The razor area appears as a semi-transparent highlight.
3. Press `Delete` or use **Edit > Delete Razor Edit Content** to remove the content within the razor areas.
4. Run **Clear Razor Edits** from the Command Palette to dismiss the razor selection without deleting.

Deleting razor-edit content currently leaves a gap; it does not apply ripple mode.

### 6.12 Ripple Editing

Ripple editing determines how clips shift when content is deleted or inserted:

| Mode           | Behavior                                                     |
|----------------|--------------------------------------------------------------|
| **Off**        | Clips remain in place when content is deleted (leaves gaps). |
| **Per Track**  | Subsequent clips on the same track shift to fill gaps.       |
| **All Tracks** | Subsequent clips on all tracks shift to fill gaps.           |

Set ripple mode via **Options > Ripple Editing** or the Preferences dialog.

### 6.13 Clip Properties

**Toggle Clip Mute**: Select a clip and press `U` to toggle its mute state.

**Toggle Clip Lock**: Locked clips cannot be moved, resized, or deleted. Toggle via **Edit > Toggle Clip Lock** or the context menu.

**Clip Volume**: Each clip has an independent volume setting (in dB) adjustable via the Clip Properties panel (`F2`).

**Reverse Clip**: Reverses the audio content of a clip. Available via **Edit > Reverse Clip** or the context menu.

**Normalize**: Adjusts clip volume so the peak level reaches 0 dB. Use **Edit > Normalize Selected Clips**.

### 6.14 Grouping Clips

Group multiple clips so they move and edit together:

- **Group**: Select clips, then `Ctrl+G` or **Edit > Group Selected Clips**.
- **Ungroup**: Select grouped clips, then `Ctrl+Shift+G` or **Edit > Ungroup Selected Clips**.

### 6.15 Quantize Clips

Align clip start positions to the grid:

- Select clips and use **Edit > Quantize Selected Clips to Grid**.
- Clips snap to the nearest grid position based on the current grid size.

### 6.16 Dynamic Split

Dynamic split automatically splits a clip at transient points or silence boundaries:

- Select a clip and use **Edit > Dynamic Split...** to open the dynamic split dialog.
- Configure threshold and minimum duration parameters.
- The clip is split at detected boundaries.

### 6.17 Transient Navigation

Navigate between transients in a selected audio clip:

- **Next Transient**: `Tab`
- **Previous Transient**: `Shift+Tab`

The playhead jumps to the next or previous transient position within the selected clip.

### 6.18 Free Item Positioning

When enabled via **View > Free Item Positioning**, clips can be placed at any vertical position within a track lane, rather than being confined to a single row. This is useful for arranging overlapping clips visually.

---

## 7. MIDI Editing

### 7.1 Opening the Piano Roll

Double-click a MIDI clip on the timeline to open the Piano Roll editor. The Piano Roll is a full-featured MIDI note editor rendered using Konva canvas.

### 7.2 Piano Roll Layout

The Piano Roll consists of several areas:

- **Toolbar**: Tool selection (Draw, Select, Erase), step input controls, quantize, scale highlighting options.
- **Piano keyboard**: Vertical piano keyboard on the left (128 notes, C-2 to G8). Click keys to preview notes.
- **Note grid**: The main editing area where notes are displayed as colored rectangles. Color indicates velocity (blue = quiet, green = medium, yellow/red = loud).
- **Velocity lane**: Bottom strip showing velocity bars for each note. Drag bars to adjust velocity.
- **CC lane**: Additional lane for MIDI Continuous Controller editing.

### 7.3 Drawing Notes

1. Select the **Draw** tool in the toolbar.
2. Click in the grid to place a note. The note's pitch corresponds to the row, and its time position corresponds to the column.
3. Drag while placing to set the note duration.
4. Notes snap to the grid if snap is enabled.

### 7.4 Selecting Notes

1. Select the **Select** tool.
2. Click a note to select it.
3. `Ctrl+Click` to add/remove notes from the selection.
4. Click and drag on empty space to rubber-band select multiple notes.
5. Use **MIDI > Select All Notes** to select all notes in the clip.

### 7.5 Editing Notes

- **Move**: Drag selected notes to a new pitch/time position.
- **Resize**: Drag the right edge of a note to change its duration.
- **Delete**: Select notes and press `Delete`, or use the **Erase** tool to click-delete individual notes.

### 7.6 Velocity Editing

Note velocity determines how loud a note plays (0-127):

- **Velocity lane**: At the bottom of the Piano Roll, vertical bars represent each note's velocity. Drag bars up/down to adjust.
- **Velocity scaling**: Use MIDI > Velocity +10% or Velocity -10% to scale velocities of selected notes.
- **Color coding**: Notes are color-coded by velocity:
  - Blue = quiet (low velocity)
  - Green/Cyan = medium
  - Yellow = medium-loud
  - Red = loud (high velocity)

### 7.7 CC Lanes

MIDI Continuous Controller (CC) messages can be drawn and edited in CC lanes:

- Click the CC lane dropdown to select a CC number.
- Available presets: CC#1 Modulation, CC#7 Volume, CC#10 Pan, CC#11 Expression, CC#64 Sustain.
- Click and drag in the CC lane to draw CC values.
- CC values range from 0 to 127.

### 7.8 Quantize

Align note start times to the grid:

1. Select notes (or select all with `Ctrl+A` in the Piano Roll).
2. Open **MIDI > Quantize Notes...** to choose the grid, strength, and whether to quantize note ends.
3. Press `Q` to reapply the last-used MIDI quantize settings without reopening the panel.

### 7.9 MIDI Transform Operations

OpenStudio provides several MIDI transform operations available via the Edit and MIDI menus:

| Operation              | Description                                               |
|------------------------|-----------------------------------------------------------|
| Transpose +1 Semitone  | Move selected notes up by one semitone                    |
| Transpose -1 Semitone  | Move selected notes down by one semitone                  |
| Transpose Octave Up    | Move selected notes up by 12 semitones                    |
| Transpose Octave Down  | Move selected notes down by 12 semitones                  |
| Velocity +10%          | Increase velocity of selected notes by 10%                |
| Velocity -10%          | Decrease velocity of selected notes by 10%                |
| Reverse MIDI Notes     | Reverse the order of selected notes in time               |
| Invert MIDI Pitches    | Mirror note pitches around a center point                 |

### 7.10 Scale Highlighting

The Piano Roll can highlight notes that belong to a specific musical scale:

1. Select a **Scale Root** (C, C#, D, ... B) from the toolbar.
2. Select a **Scale Type**:
   - Chromatic (all notes)
   - Major
   - Minor
   - Dorian
   - Mixolydian
   - Pentatonic Major
   - Pentatonic Minor
   - Blues
3. Notes outside the selected scale are displayed with a dimmed background, making it easy to stay in key.

### 7.11 Drum Editor

The Drum Editor action/state is present, but a complete mounted drum-grid editor
is not part of the current workspace. Use the Piano Roll for MIDI drum-note
editing in this build.

### 7.12 Multi-Clip MIDI Editing

The Piano Roll supports editing multiple MIDI clips simultaneously:

- When additional clips are loaded, their notes are displayed with distinct color tints (pink, green, yellow, indigo, etc.).
- The primary clip's notes use the standard velocity coloring.
- This allows comparing and editing parts across multiple clips in context.

---

## 8. Mixing

### 8.1 Opening the Mixer

Toggle the Mixer Panel with `Ctrl+M` or **View > Show Mixer** or the mixer icon in the Main Toolbar.

### 8.2 Channel Strip

Each track has a channel strip in the mixer that provides:

**From top to bottom:**
- **Track name** and color indicator
- **Track group** color badge (if member of a group)
- **FX indicator**: Shows FX count. Click to open the FX Chain panel.
- **Sends section**: Shows active sends to bus tracks.
- **Pan knob**: Stereo pan position (L100 to C to R100).
- **Volume fader**: Vertical fader from -60 dB (infinity) to +12 dB.
  - dB scale markings: +12, +6, 0, -6, -12, -24, -48, -inf
  - Gain staging indicator shows the current value.
- **Peak meter**: Real-time level display updated at 10 Hz.
- **Solo (S), Mute (M), Record Arm (R)** buttons.
- **Phase invert** toggle for polarity correction.

### 8.3 Master Channel

The Master channel strip is always visible on the left side of the Mixer:

- Controls the final stereo output volume and pan.
- Displays the master peak level meter.
- Has its own FX chain (master FX).
- Does not have Solo, Mute, or Record Arm buttons.

### 8.4 Volume and Pan

**Volume:**
- Drag the mixer fader upward to raise volume and downward to lower it, or use
  the track header volume knob. A completed drag is one undoable edit. With a
  fader focused, Up/Down adjust the value and Home/End select its minimum/maximum.
- Range: -60 dB (silence) to +12 dB.
- Double-click the fader to reset to 0 dB (unity gain).
- Volume changes are smooth (no zipper noise) due to pre-computed gain caching.

**Pan:**
- Drag the pan knob in the channel strip or track header.
- Range: L100 (fully left) to R100 (fully right), center at C.
- Pan law uses equal-power panning (cosine/sine).

### 8.5 Solo and Mute

- **Mute**: Silences the track output. The button glows when active.
- **Solo**: Mutes all non-soloed tracks. Multiple tracks can be soloed simultaneously.
- Solo and mute interact: a soloed track plays even if other tracks are muted.
- These can be linked via track groups for coordinated control.

### 8.6 Sends

Sends route a copy of the track's signal to a bus track for effects processing (reverb bus, delay bus, parallel compression, etc.):

1. In the channel strip, click the sends area or use the context menu.
2. Select a destination bus/group track.
3. Adjust the send level (0.0 to 1.0).
4. Configure **Pre-fader** or **Post-fader** mode:
   - **Pre-fader**: Send level is independent of the track fader.
   - **Post-fader**: Send level follows the track fader.
5. Sends can be enabled/disabled individually.

### 8.7 Bus and Group Tracks

Bus tracks receive audio from sends and can apply their own FX chain:

1. Create a bus track: **Insert > New Bus/Group Track**.
2. On source tracks, add sends pointing to the bus.
3. The bus receives the mixed signal from all sends.
4. Add effects to the bus (e.g., reverb, compression).
5. The bus output feeds into the master.

**Create Bus from Selected Tracks**: Automatically creates a bus and adds sends from all selected tracks to it.

### 8.8 Mixer Snapshots

Mixer snapshots save and recall the complete mixer state:

**Saving a snapshot:**
1. Configure your mixer (volumes, pans, mutes, solos).
2. Click the **Save** button in the Mixer Snapshots toolbar.
3. Enter a name for the snapshot.

**Recalling a snapshot:**
- Click the snapshot name button to instantly restore that mixer state.

**Deleting a snapshot:**
- Click the trash icon next to the snapshot name.

Use cases: A/B comparing mix versions, saving different mix passes, storing reference levels.

### 8.9 Channel Strip Gain Staging

The channel strip displays gain staging information showing the signal level at different points in the signal chain. This helps identify where clipping occurs:

- Clip gain (per-clip volume)
- Track fader position
- Master output level

### 8.10 Routing Matrix

The Routing Matrix (**View > Routing Matrix**) provides a visual overview of all signal routing between tracks, buses, and the master output. It shows which tracks send to which destinations.

---

## 9. Effects

### 9.1 FX Chain Architecture

OpenStudio supports three FX chain positions per track:

| Chain Position | Description                                                          |
|----------------|----------------------------------------------------------------------|
| **Input FX**   | Processing applied before the track fader. Used for input conditioning (EQ, compression, gating). |
| **Track FX**   | Processing applied after the track fader. Standard insert effects.    |
| **Master FX**  | Processing on the master bus output. Mastering chain.                 |

### 9.2 Opening the FX Chain Panel

1. Click the **FX** button on a track header or channel strip.
2. The FX Chain Panel opens, showing the current chain for that track.
3. Use the chain type selector to switch between Input FX and Track FX.
4. For the master, access via the Master channel strip FX button.

### 9.3 Built-in OpenStudio Effects

OpenStudio includes a set of built-in effects identified by the `OpenStudio` prefix in current releases. Legacy `OpenStudio` effect names are still accepted for compatibility in older projects and scripts.

**Approved editor redesign, 0.1.04 release candidate, October 8, 2026:** fifteen effect/instrument faces use the approved layouts. Pitch Correct opens the existing clip Edit Pitch workflow; it does not create a second graphical editor. These changes are included in the reviewed release candidate and are not yet published. NAM Rack retains its separate editor. Main controls remain visible in compact windows; detail panels scroll within the editor.

| Plugin | Editor |
|---|---|
| **OpenStudio EQ** | Full-width 24-band graph, Filter/Dynamics inspector, Minimum/Linear/Minimum FIR selector, output strip; advanced analyzer, matching and MIDI program tools remain available |
| **OpenStudio Graphic EQ** | Independent 10/31-band banks, all 31 faders in a wide window, frequency pages in compact windows, grouped edits and output trim |
| **OpenStudio Compressor** | Model-specific primary controls, native level/reduction history, detector, linking and character details |
| **OpenStudio Gate / Limiter** | Primary dynamics controls, native reduction/status readouts and model-relevant advanced controls |
| **OpenStudio Delay** | Independent stereo timing, free/sync mode, host-tempo status, feedback, balance and colour; Motion, Ducking, Routing and Dual Engine B details |
| **OpenStudio Reverb** | 41 types with contextual controls, wet/dry balance, native level readouts and the existing IR loading, preview, shape and output workflows |
| **OpenStudio Preamp / Saturator** | Drive, tone and output hierarchy with native signal-level feedback; retained engines and detailed colour controls |
| **OpenStudio Chorus** | Chorus/Flanger/Phaser modes, contextual voices/stages, independent modulation divisions and tone controls |
| **OpenStudio Gain Phase** | Manual gain, left/right timing and polarity, existing group alignment, all-pass phase shaping and spectral phase settings |
| **OpenStudio Pitch Correct** | Opens the existing Edit Pitch session for an explicitly chosen eligible audio clip; realtime parameters remain available separately |
| **Basic Synth / Piano / Clean Guitar** | Instrument-specific sound controls, advanced modulation/performance settings and audition keyboard; received keys/pedals are distinct from sounding/releasing voices |
| **OpenStudio Drums** | Sixteen audition pads, eight piece inspectors/outputs, complete 128-note remapping and Ignore, with pad labels derived from effective native mappings |

Vintage hall/random retain Build-up (0-300 ms) and independent Input diffusion. Build-up is the summed delay of four input allpass stages before the tank, not an exact acoustic attack time. Zero preserves the original input; Input diffusion zero gives a simple added delay and higher values distribute the excitation. Tank Diffusion stays separate. Both types remember their controls independently, including presets, Compare and Undo.

Drag a knob vertically, hold **Shift** for fine adjustment, or double-click to reset it. Click a value to enter a number; **Enter** commits and **Escape** cancels the entry. Normalized controls display percentages while retaining their native stored values. Focused knobs support arrow keys, Page Up/Down, Home and End. **Undo** and **Redo** apply to editor parameter gestures; an EQ node drag changes frequency and gain in one gesture. Select an EQ band by its numbered button to edit or enable it.

The other free editors now share preset/history/A/B controls and keep their main surface within the window. Detailed controls use tabs. A/B compares complete native configurations, including hidden engine settings, compressor/reverb memories and embedded IRs. Preset, Default, Compare and IR changes share editor Undo/Redo. Comparison slots last for the editor session. Editors follow their processor identity through chain reordering and reject writes after removal. Plugin options provides complete `.ospreset` import/export and the saved processor-bypass setting. A preset from another processor type is rejected. The toolbar Host bypass controls the actual FX slot and synchronizes with the chain. It is separate from the processor state stored in presets and Compare, and supports editor Undo/Redo and main-window project history.

**Original audio stages (development):** Compressor and Preamp offer Audio stages > Original stages, with Legacy as the default for both new and older state. Compressor applies separate input/output colour around gain reduction in FET, Tube Opto, Solid State Opto, Bus VCA and Punch VCA. FET Ratio Off retains these stages; Clean and Legacy models use a linear path. Headroom offset shifts the digital operating level, not interface dBu calibration. Compressor reserves the prepared 16x filter delay in addition to its 20 ms path, including the aligned dry signal. Preamp keeps the existing 4x path in Legacy; Original stages uses a prepared 16x FIR path with separately reported latency. It places input colour before Tone EQ, Output drive after it, and linear Output trim last. Audio character is a configuration change with one Undo step; Headroom and Preamp Output drive support automation. These original level- and history-dependent algorithms are not fitted commercial circuit models. Original Preamp reports 78 samples of filter delay; at 48 kHz Original Compressor reports 1038 samples in total. Original stages use more CPU than Legacy. Aggressive combined drive/headroom settings can alias; listening acceptance and reference fidelity remain open.

**Gate response:** new standalone instances select Transient response. In Gate mode, Peak/Auto detector rise is immediate before the user Attack envelope; RMS retains its integration window. Downward expansion retains its existing continuous detector response. Legacy projects and NAM keep Legacy response. There is no added lookahead, so an instantaneous pulse is not promised intact.

**Pitch entry and Humanize:** when a track has one eligible selected audio clip, Pitch Correct can use it; otherwise choose a clip. Input/master FX always require an explicit recorded clip choice. The entry checks whether realtime correction is already active on the clip's playback route before opening the existing graphical session. It does not silently bypass that effect. Realtime Humanize offers Legacy amount and opt-in Sustained notes; the latter starts relaxing correction after a 200 ms onset grace and ramps over 400 ms. Old state keeps Legacy. This does not add Humanize to the graphical editor.

**Pitch automation:** graphical note edits change the clip's working audio and
do not require a track envelope. Envelopes for Pitch Correct control its
compatible realtime FX processor (for example Retune, Mix or Bypass), separately
from the graphical Edit Pitch session opened by its entry button.

**Delay readouts:** synced milliseconds reflect the processor's nominal effective delay. Tempo status distinguishes the current host value, a retained host value, and the 120 BPM fallback. It does not display the instantaneous modulated read head. Free delay values are retained while sync is active. Diffusion Span is added after the repeat and is not timing compensation.

**Instrument export:** the host reserves rate-aware release bounds, including supported release automation and coupled-body decay, and releases sustain/sostenuto at the end of exported content. Held live notes and intentionally indefinite effects are separate from a finite release tail.

#### Parametric EQ

EQ's toolbar provides preset save/load, Default reset, Undo/Redo, A/B, copy and Host bypass. A/B slots last for the editor session; presets and project state persist. Host bypass controls the FX Chain slot; the retained DSP bypass field belongs to complete EQ state. Select a band on the graph or band strip; double-click empty graph space to enable an unused non-cut band. Filter and Dynamics reuse the same inspector area. Controls that do not apply to the selected filter are hidden. Auto gain estimates compensation from the filter response; it is not measured loudness matching. Spectrum and output meters display dBFS, not LUFS or true peak.

The standalone EQ now has 24 bands on three pages of eight; the channel-strip EQ retains eight. Added bands start disabled, and all bands are available on the graph and Listen control. Each standalone band has a Stereo/Left/Right/Mid/Side target. Global Mid/Side processing overrides individual targets; choose Stereo to use them. With individual targets, the graph shows the stereo-energy response for equal-energy uncorrelated inputs, including the ordered interaction of L/R and M/S filters. It is not the response of every possible stereo input. In Minimum phase, Auto gain is unavailable while an enabled band uses an individual target. Linear phase estimates compensation from its full stereo matrix. Cuts add 72/96 dB/octave Butterworth choices; shelves use the existing gain-distributed cascade behavior. Old projects keep their first eight settings and restore added bands disabled. Band IDs keep their automation positions. Spectral dynamics are described below; Opt-in Minimum FIR supports continuous and finite-brickwall cuts with compensated latency. Matching and analyzer workflows are described below.

**EQ instances and preset library (development):** Instances opens a searchable list of running track/input/master EQs. Edit navigates to the full editor in the same window, retaining separate Undo/Redo histories. Pins, pin sets, local names and ordering are browser-profile view preferences tied to running instance IDs; they do not rename or reorder tracks and are not project data. Track order restores the host ordering when available. Compare starts anew when navigating. The preset toolbar ellipsis opens EQ preset library: search names, folder, tags, author and notes, filter Favorites, refresh, then Load selected. Local metadata is not embedded in preset files. Copy settings / Paste settings transfers the complete EQ state between instances sharing this browser profile; Paste is one Undo step and rejects other plugin types.

EQ Instances now offers Graph overview. Compare up to six native response curves per page, with optional input/output spectra, selectable gain range, search and pinned sets. Spectra have their own -100 to 0 dBFS scale. Offscreen graphs pause; Pause graphs freezes visible snapshots. Edit opens the selected instance in the same window with its independent Undo history. Removed or unavailable instances show a message instead of retaining a stale response.

The EQ preset library has a Files & startup tab. Import file applies a complete `.ospreset` as one undoable change; Export current saves the complete current state with native overwrite confirmation. Open preset folder opens the native library. Use current for new EQs saves a startup default for newly added track, input and master EQs; Factory for new EQs clears it. Existing instances, saved projects and explicitly recalled presets retain their own settings.

EQ preset library > MIDI programs stores up to 32 captured settings with stable bank/program addresses. Stop playback and recording to edit the map. Capture each setting while recall is disabled, then enable recall and choose Omni or a channel. Numbers are zero-based: bank = CC0 x 128 + CC32, followed by Program Change. Capturing the same address replaces it. Maps travel with projects, presets, Undo/Redo and Compare. Mixed phase, quality, Minimum FIR/Analog, spectral/Linear dynamics and external-key configurations are prepared before activation. The armed bank reserves its largest latency for every setting; each change warms the incoming processor and crossfades over 20 ms. Rapid recalls finish an audible fade before starting the latest requested setting. Only the current and incoming processors run. Event timing selects the target; it does not make an audible crossfade instantaneous. Disable recall before manually changing processing configuration. Same-configuration maps keep the existing sample-timed target path. Unmapped MIDI passes downstream unchanged. Prepared-bank draft audition leaves the saved EQ and its reserved latency unchanged.


**Plate filter and material controls (development):** Studio Plate adds a Decay filters tab: Legacy damping preserves prior behavior, Off removes additional feedback loss, and Low-pass uses a separate 200 Hz-20 kHz decay corner. Output low-pass off independently bypasses the returning High Cut filter. Hold suspends feedback loss; retiring Studio Plate tails retain their settings. Legacy and Modal engines keep their separate tone controls. Modal Plate adds Material: choose Coefficient for the original Bending coefficient, or Material to derive bending from Young modulus, density, thickness and Poisson ratio. Tension speed remains independent. Exciter and Pickup radii set ideal Gaussian spatial footprints in mm (standard deviation); zero retains point contacts and larger radii reduce short-wavelength modes. Geometry/material/contact edits clear the Modal tail and use complete-state Undo/Compare/preset recall. This is a normalized, finite-mode model of an ideal supported rectangle, not a measured physical plate or vendor-model calibration.

The Phase selector chooses Minimum phase (the unchanged zero-latency default) or Linear phase. Linear phase uses symmetric finite filters at Low/Medium/High resolutions: 1025/4097/16385 taps and 768/2304/8448 samples of latency. Higher resolution gives finer low-frequency shaping at increased delay and CPU cost; the graph shows the actual finite response. Host compensation aligns parallel tracks and exports. Bypass retains the same delay. Linear phase applies static bands by default; enable Linear band dynamics for ordinary dynamic bells/shelves, or Spectral for per-bin correction. Phase/resolution changes restart filter history and are not automatable. Ordinary band edits build on a worker and crossfade using existing input history; Updating filter indicates pending work. Presets, Compare and Undo retain the mode and resolution. This original FIR mode does not claim proprietary Natural Phase behavior; pre-ringing and listening quality require audition.

All Pass changes phase in Minimum phase, using Frequency and Q; it is inactive in Linear phase. Linear-phase high/low cuts also offer a continuous 3-96 dB/oct target and a finite brickwall target. Resolution controls the finite transition width; the graph shows the actual filter. The default zero-latency path retains stepped slopes. Enable Minimum FIR for advanced cut targets; its causal finite kernels add 256 samples of compensated delay. Analog target adds another 256 samples (512 total) and uses original unwarped prototype responses. Quality controls finite-tail accuracy. Older states keep both options Off; the graph shows the prepared response. These are finite-band approximations, not proprietary Natural Phase emulations.

**Grab** freezes the current raw output spectrum (Input when the Analyzer is set to Input). Drag a numbered peak horizontally for frequency and vertically for gain; release to add a bell. Initial Q estimates the peak width from the display grid and stays bounded; use the wheel over the peak or the Q box to adjust it. Keyboard users can choose a peak, focus its numbered handle, use Left/Right for frequency and Up/Down for gain (Shift for fine changes), then Enter to apply. Escape cancels a draft; a second Escape or Exit grab returns to the normal graph. Drafts leave audio unchanged unless Audition peak is enabled. That temporary preview follows frequency/gain/Q edits, with one update in flight and short filter-output crossfades. Stop audition, Escape, Recapture or closing Grab cancels it. Release/Enter/Apply still commits one bell and one Undo step. Audition requires active Stereo with Auto gain and Listen off; it supports ordinary dynamics and prepared Linear, Minimum FIR, Analog and spectral paths; it never enters saved state or offline export. The capture is independent of analyzer tilt, hold and pause. No peak detection is a claim that the signal needs correction.

Standalone EQ Analyzer also offers **External key** and **All + key**. The pink trace shows the raw track-FX sidechain bus before detector filtering and does not depend on the Dynamics Key source setting. Assign the source with the FX chain SC selector. Left/Right/Stereo power and display history apply to this trace too; missing sources show silence. Grab captures that key when External key alone is selected. Input/master FX have no track-source route. The separate References workflow supplies supported EQ-instance overlays; the raw external-key trace is not a masking diagnosis.

Standalone EQ Dynamic Range extends to +/-30 dB, with static plus dynamic filter gain still limited to +/-30 dB. Embedded channel EQ retains +/-24 dB. Existing automation keeps its original mapping; the new Range control records the expanded range.

The EQ Dynamics tab adds independent Threshold (Manual/Adaptive) and Timing (Manual/Auto). Adaptive replaces the fixed threshold with Sensitivity (-12 to +12 dB): positive values increase triggering. It learns the filtered key level with slower recovery and displays its effective threshold. Auto timing follows band frequency, range and key transients, with live attack/release readouts. Switch back to Manual to recover the saved Threshold/Attack/Release values. Dynamics must be On with a non-zero Range. Global/Internal/External and Band/Free detector choices also feed these modes. Older projects retain Manual/Manual. These original band-level rules apply in Minimum phase and opt-in Linear band dynamics; Spectral supplies separate per-frequency detection.

The **Detector** tab configures each dynamic bell/shelf separately. Band key can inherit the Global key from Dynamics, or override it with Internal/External. All External bands share this EQ's FX-chain SC source. Band triggering follows the band's frequency and Q; Free uses independent second-order high/low-pass cuts. Low cut is limited to 19 kHz, high cut stays at least 5% above it, and DSP limits both below Nyquist at lower device rates. Listen key auditions the selected filtered detector, even with that band's Dynamics off; a persistent status row provides Stop key listen. Bypass restores main audio. Source and trigger changes smooth over 10 ms and audition over 15 ms. Detector settings survive project, preset, Compare and Undo; older state defaults to Global/Band with audition off. Linear phase requires Linear band dynamics or Spectral for dynamic correction; key audition uses the prepared frequency stage. This is one auxiliary bus per EQ, not independently routed tracks per band.





**HPF / LPF:** the default first and last bands are High Pass (Low Cut) and Low Pass (High Cut), initially off. Their band-strip entries show HPF/LPF, cutoff frequency and a power button. Enable one to see its labeled cutoff handle and the combined filter roll-off on the graph. Select it to edit Cutoff, Slope and applicable Q. Drag its graph handle horizontally to change cutoff without changing gain; Undo restores the gesture. Disabled cuts contribute no roll-off and have no active graph handle. The graph responds to settings even while playback is stopped. Changing a band's Shape updates its label; older presets retain their existing band types. Adding a bell by double-click does not repurpose a disabled HPF/LPF.

**EQ Match (development):** Open Match in the standalone EQ. Play with looping off and Learn current output, then select an existing track/input/master EQ and Learn reference output. Each learns about four seconds of stereo output; the same instance can learn another passage as reference. Choose Maximum bells, Propose match and review the gray target/blue fitted curve. Apply bells adds up to eight static Stereo bells to unused bands in one Undo step, preserving existing filters and trim. Current processing must be active Stereo with Auto gain and band Listen off. Dynamic processing can be captured; the static proposal matches that captured average, not every moment of a changing envelope. Changed settings, silence and insufficient shared broadband energy reject learning/apply. Matching removes average level difference and covers 80 Hz to min(16 kHz, 40% of sample rate); bells are limited to +/-9 dB and Q 0.35-3. It does not match loudness or perceived sound. Use Undo/Redo or Compare to audition. Unsaved captures are temporary and live captures may contain gaps between analysis windows.

**EQ reference files and library (development):** EQ Match also offers Learn audio file: select mono/stereo WAV, AIFF or FLAC at 8-192 kHz and enter File start in seconds; up to four seconds are analyzed without playback. A section shorter than 8192 samples is rejected. Save current or Save reference stores one of up to 32 named spectra on this device/browser profile; select it under Saved reference and use Remove saved to delete it. Libraries contain spectrum/analysis metadata only, not audio, file paths or EQ state, and are not included in projects/presets. Corrupt or full storage reports an error without replacing existing data. References can be reused at another sample rate when their measured frequency range covers the current grid; otherwise relearn at a higher rate. Current live output still needs a fresh capture after its processing changes.

EQ's **Display** popover controls only its analyzer view: 60/90/120 dB range, Instant/Fast/Medium/Slow release, and 0/3/4.5 dB-per-octave tilt around 1 kHz. **Hold peaks** accumulates maxima; **Pause** keeps a fixed snapshot; **Clear** resumes from the current input. Tilt is labelled separately from the dBFS scale. The EQ curve, band nodes, audio and Undo history stay unchanged. Settings last for the open window and are not saved in projects or presets. Escape or a click outside dismisses the popover.

Draw and EQ Match now offer Audition proposal before Apply. This temporarily processes the proposed filters without changing saved bands, presets/projects or Undo. Stop audition restores the current EQ; Apply commits the proposal as one Undo step. Use active Stereo with Auto gain and Listen off. Audition follows ordinary dynamics and prepared Linear, Minimum FIR, Analog and spectral paths without changing latency. Changing the proposal/settings, closing its panel, losing the editor connection, stopping the audio device or starting offline rendering cancels audition. Saved state always contains the committed EQ. Dynamic and prepared-phase previews are included; Grab has its own Audition peak control. Match resets unused-band special settings when applying so an older Gain-Q or spectral mode cannot alter the fitted correction.

EQ **Display > Resolution** selects 1024, 2048, 4096 or 8192 samples. Larger windows separate nearby frequencies better but take longer to collect. **Source** selects Left, Right or Stereo power (mean channel energy, so opposite phases do not cancel). Defaults remain 2048 and Left. The popover reports the actual window duration and bin spacing. Changing resolution/source clears the displayed capture, including a paused snapshot, until a compatible frame arrives; it does not change EQ audio, latency, presets or Undo.

The EQ's Peaks menu captures up to six prominent input-spectrum frequencies. Choose one to add a neutral 0 dB bell with Q 1, then adjust its gain. The entire addition is one Undo step. Capture uses the current input frame independently of display tilt, hold or pause; the captured list stays fixed until recaptured and clears when resolution or channel source changes. Frequencies are approximate display-grid values, not diagnoses or automatic correction. Existing cut bands are reserved; if no other disabled band is available, free one first.

EQ Display offers opt-in Automatic Spectrum Grab for this editor window. Rest the mouse near the displayed spectrum for 1.8 seconds to freeze current raw peaks. Moving, leaving, dragging, pausing, changing analyzer source/resolution or running out of free bands prevents that capture. Explicit Grab remains available for keyboard and touch. Keep capture retains the frozen frame after each bell and marks used peaks; every applied bell has its own Undo step. Recapture updates the spectrum and re-enables its candidates. Capturing leaves audio unchanged; editing changes it temporarily only when Audition peak is enabled. Release, Enter or Apply bell commits one change.

**External detector keys (development checkout):** standalone Compressor, Gate and dynamic EQ offer **Key source > Internal / External**. In track FX, choose the feeding track with that effect's **SC** selector. Each effect can use a different source; the source follows reorder/removal Undo, track duplication and project recall. Sources are the source track's processed post-fader output, so mute/solo and the source FX affect the key. Missing sources feed silence. Input and master FX cannot receive track keys. Source switching crossfades for 10 ms; Compressor retains its fixed 20 ms main/detector alignment. Gate's Detector Listen monitors the selected key. Dynamic EQ bands can follow the global key or override it with Internal/External, using their own band filters and targets. Stem and selected-item exports process required upstream source tracks without adding them directly to the output mix. Existing states default to Internal. The EQ analyzer can display the raw external key spectrum independently of detector selection. Hardware/plugin timing remains unqualified.

EQ **Group** selects any combination of the 24 bands, or all/enabled bands. Relative offsets shift frequency by the same number of semitones and add a common gain offset to bells/shelves. The whole edit is rejected if a selected value would exceed its native range, preserving frequency ratios and gain differences. Group also offers Flip gain and range, Enable, Bypass and Reset to defaults.

Scale gain and range multiplies both signed dB values around zero (0-2x) for bells/shelves. Scale Q multiplies Q (0.125-8x) where that control is active, skipping 6 dB/oct cuts and continuous/brickwall Linear-phase cuts. Any native range violation rejects the whole group. Each Apply is one Undo step and retains full-state Compare. Bypass/reset clears audition for affected bands. Selection is shared with the graph and inspector. Rectangle or modifier-click selection and grouped drags preserve relative values; Escape cancels the gesture.

Group Copy/Paste uses a separate validated local group clipboard shared by editors with the same browser storage. Paste creates enabled bands in unused non-cut slots outside the current selection, selects the pasted group and records one Undo transaction. Insufficient slots or invalid clipboard data cause no parameter changes. Values are bounded by destination descriptors. System clipboard and separate WebView storage profiles are outside this workflow.

EQ **View** offers 1x/2x/4x/8x frequency zoom, center/pan, Focus band and Full range. It affects this editor window only. Analyzer references use the same axis; Grab captures visible peaks. Changing the view discards an unapplied Grab draft. Filters outside the view remain available in the band inspector.

Click the selected EQ band name to open its actions: Copy, Paste as new, Duplicate, Flip gain and range, Reset and Remove. Paste/Duplicate use an unused non-cut band and each edit is one Undo step. Reset/Remove also stops listening to that band. The validated local EQ clipboard is shared by editors using the same browser storage; it is separate from the system clipboard. It copies scalar band controls, including dynamics, detector settings and stereo target, while global processing and other bands stay unchanged.

The EQ band menu also accepts frequency text such as 2k, A4 or C#3+12ct. Notes use twelve-tone equal temperament with A4=440 Hz; Apply rejects frequencies outside the native band range and is one Undo step. View offers +/-3/6/12/30 dB gain scales. The spectrum keeps its dBFS scale while filter curves zoom. Offscreen band handles remain editable in the inspector; Focus band chooses enough range to reveal the selected gain. Full range restores both axes.

**Selecting and editing several EQ bands**

Drag a rectangle on empty EQ graph space to select the bands inside it. Shift-click, Ctrl-click or Command-click a graph node or band-strip button to add/remove it. The Group popup uses the same selection; its checkboxes also select bands on the graph. With graph focus, Ctrl+A / Command+A selects the visible enabled bands.

Drag any selected node to move the group. Frequencies keep their ratios; gain-capable shapes keep their gain differences. The whole group stops at the first parameter limit. Arrow keys shift frequency or gain, Shift makes smaller changes, and Alt+Up/Down scales eligible Q values. Escape cancels a drag. One editor Undo restores the entire gesture.

The inspector applies frequency/gain/Q edits relatively to the selection. Shared shape, target and applicable dynamics/detector settings use the chosen value for compatible selected bands. The displayed controls belong to the active band. Double-click empty graph space to add a band; a single background click changes selection without creating a filter.

EQ Draw lets you draw an added correction with mouse/touch or edit its points using the keyboard and numeric Gain field. Shapes selects Bells or Bells, shelves and cuts. Fit proposes up to eight static Stereo filters; Apply adds them to unused non-cut slots as one Undo step, preserving existing filters and resetting reused slots. Use active Stereo with Auto gain and Listen off in any phase mode. Drawing and fitting do not change audio. Bells uses a +/-12 dB target with fitted gains up to +/-9 dB and Q 0.35-3. Mixed mode accepts -48 to +24 dB targets and fits bells/shelves up to +/-18 dB plus 6/12/24/48 dB/oct cuts. Drawing spans 80 Hz to 16 kHz, lower at low sample rates. Gray shows the target and blue the fitted correction. RMS residual is a fitting diagnostic. Settings or sample-rate changes require refitting. Fitting is approximate, not exact source-filter recovery.

EQ References shows up to two other EQ instances with Input/Output spectra, following Display resolution, channel, range, tilt, Hold and Pause. Refresh instances after adding or removing effects. Missing instances clear their overlay. Overlap guide shades jointly strong energy against this EQ's output; it is disabled during Hold/Pause and does not establish perceptual masking. Independent capture times limit transient comparisons. These are local-window views; audio, routing, project state and Undo remain unchanged.

Standalone EQ adds Spectral processing above the graph. Enable it, select a bell or shelf, open Dynamics and select Spectral; Dynamic must also be On with a non-zero Range. Density controls how narrowly frequencies trigger, and +3 dB/oct key tilt emphasizes higher detector frequencies. Manual/Adaptive threshold and Manual/Auto timing remain available, with Global/Internal/External keys. Free restricts admitted key frequencies. Per-frequency correction follows the static EQ, whose Minimum/Linear phase setting remains unchanged. Low/Medium/High add 1024/2048/4096 samples of delay, in addition to any static FIR latency. Stage enable and resolution restart processing history and are not automatable; per-band controls retain normal automation, Undo, presets and Compare. Bypass keeps delay. Listen suspends spectral correction and auditions the selected key; Linear uses the prepared frequency stage. The graph shows static filters; the spectral gain readout is the strongest per-bin correction, and adaptive threshold is a mask-weighted summary. These original algorithms do not claim reference sound or measured hardware performance.

EQ adds Tilt Shelf and Flat Tilt. Positive gain brightens the sound around the Frequency pivot. Tilt Shelf combines opposing low/high shelves and exposes Q; Flat Tilt distributes eight gentle shelves across the range and normalizes the pivot, approximating a straight log-frequency tilt without a Q control. Gain-Q on Bell subtly narrows the filter as gain rises and increases gain at high Q; it defaults off. Frequency now accepts 10 Hz-30 kHz, including musical entry and group operations. Requested centers are saved; processing and graph data remain below Nyquist. Existing automation ranges are preserved through appended controls. Band actions can split an enabled Stereo band into Left/Right or Mid/Side, using one unused band and one Undo step. Global processing must be Stereo. Split copies settings and avoids inserting across filters with conflicting L/R versus M/S targets; free an adjacent band if no compatible slot is available. Split Dynamics can respond independently per target. The new shapes are static, including in Linear phase; tilt Dynamics are unavailable. The curves are original designs rather than calibrated vendor copies.

In EQ Linear phase, enable Linear band dynamics for ordinary dynamic bells/shelves. This adds a prepared frequency stage with one filtered RMS detector per band; Spectral remains a separate per-frequency choice. Both use the selected resolution, with their stage delay added once to static FIR latency. Bypass retains the delay. The graph shows static response and activity shows dynamic gain. Key Listen works in the prepared linear path and Stop key listen exits it. Old state leaves Linear band dynamics Off.

#### Compressors

**Compressor:** new standalone instances offer Clean, FET, Tube Opto, Solid State Opto, Bus VCA and Punch VCA. Models use peak or RMS detection and optical release memory; they are original dynamics models, not licensed circuit emulations. Selecting a model applies starting timing/ratio values in one undo step. Legacy states recall the previous Style selection. Models retain their own settings in project, preset and Compare state. Standalone Legacy audio character uses a fixed 20 ms aligned dry/wet path while Lookahead changes detector timing. Opt-in Original stages adds its oversampling-filter latency to that path. NAM Rack retains its existing compressor path. **Gate:** new instances use sample-rate-independent detector timing; older states retain their historical timing until Rate-correct timing is enabled. **Limiter:** Maximize supplies continuous gain toward Ceiling. The standalone path reports 20 ms of lookahead plus its output guard and any selected oversampling filter delay. True Peak is enabled for new instances and adds an 8-phase reconstructed-peak safety envelope with a 0.5 dB reserve. Turning it off retains sample-peak limiting; older states default to off. Final-output checks use an independent 16x FIR reconstruction at 44.1/48/96/192 kHz. The output rail measures true peak with a separate 16x FIR and shows K-weighted momentary (400 ms) and short-term (3 s) loudness. Integrated loudness and LRA are available in the measurement panel below. Calibration fixtures pass; full EBU test-set certification and arbitrary-input guarantees are not claimed.

Standalone Compressor's **FET** model adds an **Input-driven** engine. Response offers Legacy/Input-driven selection, 4:1/8:1/12:1/20:1, All buttons and Off, Attack (0.02-0.8 ms) and Release (50-1100 ms). Smaller times are faster. Input (-24 to +36 dB) drives both signal and detector; Output (-36 to +24 dB) follows reduction. Generic Threshold/Makeup/Auto makeup controls are hidden in this engine. Ratio Off removes compression over 20 ms while retaining Input/Output gain; detector/timing controls are hidden until a compressing ratio is selected. Recovery memory controls exposure-dependent release. All buttons uses a wider knee and different threshold/timing/memory law; it is an original approximation, not a circuit or distortion match. Detector filtering, lookahead and linked stereo detection remain available. Mix blends with the aligned, unamplified dry signal, and latency is unchanged. Input/output meters remain dBFS, with GR in dB, not hardware VU calibration. The FET settings survive model changes, projects, presets, Undo and Compare. Older states retain Legacy until Input-driven is selected. Optional Original stages adds independent input/output colour and a digital Headroom offset; calibrated hardware response remains unqualified.

Input-driven FET > Detector adds **Key tilt**, separate from Sidechain HPF. On emphasizes the selected internal/external key by approximately 3 dB/octave, with unity gain at 1 kHz, before gain detection. The audio signal itself is not filtered. The original digital approximation is qualified from 100 Hz to 6.4 kHz; its bounded low/high-frequency response is not a commercial circuit model. Toggle changes smooth over 20 ms. Ratio Off hides the inactive detector controls. Old states restore Key tilt Off; model switching, presets, Compare and Undo retain the setting.

The input-driven FET offers five additional adjacent-button profiles: 4+8, 8+12, 12+20, 4+8+12 and 8+12+20. Each uses an original ratio, knee, threshold and recovery law; these are not calibrated hardware models. Existing single ratios, All buttons and Off remain available. Punch VCA has Noise & monitor: optional per-channel synthetic noise and 50/60 Hz hum, with zero preserving the original output. At 100%, the floor is -78 dBFS RMS noise plus -84 dBFS peak hum, added after wet gain and scaled by Mix. Linked uses the first level for both channels; Dual mono and Mid/Side retain independent levels. Monitor acts after Mix: Stereo, Left, Mono or Right. In Mid/Side routing, Left and Right audition Mid and Side. These controls retain Undo, Compare and portable state. The noise is generated, not sampled from hardware.

Standalone Compressor's **Tube Opto** and **Solid State Opto** now offer an **Optical** engine, each with its own settings. **Peak Reduction** (0-100) increases compression; zero removes reduction while retaining **Gain** (0-40 dB). Gain follows the detector and does not increase compression. **Compress** uses a nominal 3:1 soft-knee response; **Limit** applies a stronger optical response, not a brickwall ceiling. **HF Emphasis** increases from flat at zero toward reduced low-frequency detector sensitivity at 100%; it does not EQ the audible signal. The two models use different energy/attack and recovery profiles, with fast and slow release components plus exposure memory. Normal optical controls hide generic Threshold, Ratio, Attack/Release, SC HPF and automatic makeup; Lookahead, Stereo Link and aligned Mix remain available. Fixed latency remains 20 ms. Both optical banks survive model changes, project/preset recall, Undo and Compare. Older states restore **Legacy** until Optical is selected. These are original digital response models; measured photocell, tube/transformer coloration, hardware headroom and VU calibration are not implemented.

Standalone Compressor's **Bus VCA** and **Punch VCA** add an **RMS VCA** engine. Bus uses a soft knee, Input (-18..18 dB), Threshold (-50..-10 dB), Output (0..40 dB), Attack (0.3..50 ms), Release (100..4000 ms) and Auto Release. Auto Release ignores the saved manual Release value, which is hidden until Auto is disabled. Punch uses a hard knee, Input/Output (-20..20 dB), Threshold (-60..-9 dB) and automatic program-dependent timing. Finite ratios span 1.5..100:1 for Bus and 1..100:1 for Punch. **Infinity ratio** replaces the finite ratio with an infinite steady-state ratio; it is not a brickwall safety limiter.

**Routing** offers Linked, Dual mono and Mid/Side. Linked applies the first bank to both channels and retains the second bank for later recall. In Dual mono, **Channel** selects independent Left/Right settings; in Mid/Side it selects Mid/Side settings, using a normalized sum/difference matrix. Each path has independent detector history. Switching routing crossfades over 20 ms. Mono instances use the first bank as Linked. The per-channel **SC 90 Hz** switch only high-pass filters detection. **Curve** contains Input and ratio; **Timing** appears only for Bus; **Detector** contains SC 90 Hz and shared Lookahead. Mix blends with unchanged aligned dry audio, with fixed 20 ms latency. Input/output meters remain raw-input/final-output dBFS; GR reports the maximum active channel reduction. Both banks persist through model changes, projects, presets, Undo and Compare. Existing states restore Legacy. These original responses do not establish measured VCA/transformer coloration, exact hardware timing, noise or VU calibration equivalence.

**Compressor meter views (development):** The standalone Compressor center meter can show Gain reduction, Input average or Output average. Average views select Stereo max, Left or Right, with 0 referenced to a sine peak from -24 to -6 dBFS (default -18). Input is measured before Input drive and output after wet/dry mix. The level meter uses an original rectified, sine-calibrated 300 ms average response; it is not certified VU ballistics or a calibrated hardware dBu reference. Side In/Out meters remain peaks and Gain reduction retains the native block peak. These display settings support Undo, Compare and preset/project recall without changing audio or automation.

Limiter Response adds Crest (crest-adaptive recovery), Bus (soft-knee RMS compression before peak protection), Edge (minimal hold and fast recovery) and Gentle (cascaded reduction smoothing). Classic, Swift, Balanced and Sustain retain their existing behavior. Edge hides Slow attack, Auto recovery and Release link because those controls do not apply. The new strategies use the existing independent peak guard and quality settings. They are original response laws, not commercial-style emulations.

Limiter Quality offers Off (1x), 2x, 4x, 8x, 16x and 32x audio processing. The limiter runs at the selected higher rate, then protects and meters the downsampled output. Quality changes restart processing history and update host delay compensation; they are saved in projects, presets and Compare but are not automatable. Old projects default to Off. At 48 kHz the total delays are 960, 1078, 1093, 1099, 1103 and 1104 samples respectively. Higher factors use more CPU; 16x/32x are primarily useful for offline evaluation. Oversampling does not establish better audible quality or guarantee every possible reconstructed peak.

#### Reverb and convolution

Standalone Reverb also shows current-block L/R input and output sample peaks in dBFS. The output reading includes wet/dry mix, Send and ducking; mono is shown in both columns. Silence or unavailable data appears as a dash, and readings at or above 0 dBFS are highlighted. Current shows the latest block; Maximum shows native maxima retained across blocks until Reset peaks, processor reset or prepare. A 0 dBFS reached indicator stays visible after a brief full-scale event. Reset peaks acts on the next audio block, with pending status if processing is stopped. This telemetry action does not change audio, saved state or Undo. These are sample peaks, not true-peak or loudness measurements. Short windows keep the labelled numeric output controls visible while hiding their duplicate knobs.

**Reverb:** Room, Hall, Plate, Chamber, Spring, Shimmer, Nonlinear, Convolution, Church, Ambience, Vintage hall and Vintage random remember separate settings. Church has a larger sixteen-line network with dense scattering, long reflections and a 6 s default decay; Ambience emphasizes short early reflections over a quiet, sparse late field with a 0.35 s default decay. These two types always use their dedicated networks; they have no Legacy selector.

Reverb peak measurement defaults to Sample. Choose 8x peak for an optional finite reconstructed-peak estimate in dBTP, with independent input/output L/R readings, Current/Maximum views and Reset peaks. The choice is saved and supports Undo/Redo and Compare; measured maxima are transient. Reset takes effect on the next audio block. Turning the estimate off clears its histories and stops its extra computation. This meter adds no audio latency and does not change or limit audio. It is an estimate, not a certified true-peak meter. Short editor windows keep the labelled numeric Wet/Dry/Width controls visible instead of the duplicate knobs.

Nonlinear Hold circulates stored excitation through the current early envelope and sustains the independent late network. Freeze excludes new input; Infinite adds new diffused input. Duration and Shape edits wait for release, and modulation pauses. Output tone and Late level remain active. The early pattern repeats over Duration; this is an original hold mechanism. Releasing Hold restores ordinary feedback and decay; Spillover releases outgoing Hold before draining.

Nonlinear reverb has a Motion tab. Modulation moves both the reflection taps and the late reverb delays, with up to 2 ms peak movement at full depth. Mod rate controls both stages from 0.05 to 8 Hz. The default zero depth retains fixed delays. This is an original modulation design; the timing graph still shows only the early amplitude envelope.

Reverb adds Drifting hall, Drifting chamber and Drifting diffuse. These original spaces use separate long, short and medium-delay networks. Tape feedback adds Drive and frequency emphasis around feedback saturation; zero Drive retains linear feedback. Motion combines irregular Wow and faster Flutter with a shared rate control. Tone includes independent Bass decay and crossover. Each type remembers its settings. Freeze excludes new excitation, Infinite admits it, and both suspend saturation and moving delays until released. Spillover retains the outgoing settings and lets the old tail decay when changing types. The existing Vintage hall/random stay unchanged. The new type selector preserves old automation mappings. These are original algorithmic spaces, not calibrated reproductions of commercial reverb or tape hardware; the timing guide remains nominal.

Reverb adds Clear plate, Clear room and Clear random. Clear plate uses sixteen delays with distributed output taps; Clear room uses eight shorter delays and explicit early reflections; Clear random crossfades between stationary randomized taps. Onset separates Early diffusion from Onset spread; Space retains Late diffusion. Motion controls depth and rate, while Tone separates Bass decay and crossover from damping and wet filters. Each type remembers its controls, supports Freeze/Infinite and can retain its outgoing tail with Spillover. Onset spread shapes delay timing rather than adding a fixed silent wait. These are original algorithmic spaces; the timing guide is schematic and commercial sound equivalence is not claimed.

Reverb adds fourteen original digital spaces: Radiant hall, Diffuse plate, Compact room, Cross chamber, Ensemble space, Reflection field, Vault, Grain hall, Grain plate, Shaped reflections, Long nave, Grand gallery, Aperture chamber and Aperture hall. Each remembers its own settings. Feedback spaces offer 0.1-70 s nominal Decay, independent Early/Late diffusion, Motion, Bass decay and Hold input policy. Attack spreads the onset, except Reflection field where it balances early reflections against the tail. Shaped reflections instead has a 25-2000 ms Duration and an envelope that moves from truncated decay through flat to reverse; it has no Hold or feedback tail. Era changes among prepared 24/32/48 kHz processing paths, capped at the host rate, with filtered conversion and different resolution/bandwidth. Grain keeps feedback quantization even in Clean. The two Aperture spaces add a feedback-smoothing control. Spillover preserves outgoing type/era settings with a 120-second retirement cap. These are original algorithms and nominal controls, not calibrated reproductions of commercial reverbs.

Reverb's Rendered response button replaces the schematic with a read-only diagnostic view. Select a 2, 5 or 10-second window and a Left, Right or Both impulse, then Render response. A fresh wet-only copy uses the current sample rate and published tempo with a -12 dBFS impulse per selected input after 100 ms silent warm-up. Blue/green are left/right, solid lines are peak envelopes and dashed lines are RMS; exact maxima are shown below. Rendering changes neither playback settings nor Undo. Cancel or close stops the worker; changing settings, tempo or rate invalidates the graph. Long predelay or Freeze may produce silence within the finite window. This level-dependent result includes current wet processing but starts with an empty tail; it is not a measured room IR or certified RT60. Preparation stages may finish before cancellation takes effect.

New Room, Hall and Chamber instances use distinct Studio feedback networks and stereo early reflections. Size changes propagation timing independently of nominal Decay; adjusting Size can create a pitch glide while delay lengths settle. Tone & motion adds Modulation and Bass decay (0.5-2x, with a 250 Hz transition), alongside damping, filters and Freeze. Bass decay is a low-frequency target; actual broadband decay also depends on damping and modulation. Each space remembers these controls and its engine selection independently. Older states retain Legacy until Studio is selected; Legacy hides the new controls. These are original algorithmic spaces, not measured-room or commercial emulations.

Prepared **Room > Character** selects Original or Compact bright when Space engine is Studio. Compact bright uses shorter reflections and a separate, less damped network. Both characters share Room controls; Spillover retains the outgoing tail. Legacy uses the original compatibility engine. Old projects select Original.

Studio Room (both characters), Hall, Chamber, Church and Ambience add **Decay filters**. Decay filter selects Legacy damping, Off, or Low-pass with a 200 Hz-20 kHz cutoff. This controls high-frequency loss inside the feedback network. **Output low-pass off** independently bypasses the returning sound's High Cut filter. Legacy damping keeps the original Damping knob; Low-pass uses the Hz cutoff instead. Each space remembers both settings. Hold suspends decay filtering, and outgoing tails retain their own settings. These are original digital filters; old projects retain Legacy damping and the enabled output filter.

Contour room, Open hall and Diffuse loop add Low shelf (-24 to 0 dB), an original first-order 250 Hz shelving cut on incoming audio and every repeat. Zero dB is Off. Low Cut remains a separate high-pass filter. Each spatial type remembers its shelf. At zero input delay, Feedback is ineffective while its saved value remains available for a nonzero delay.

Convolution Motion adds 0-5 ms depth and 0.05-5 Hz rate on a separate Motion tab. It varies a short fractional delay after the wet IR return, with offset stereo phases, so pitch moves; this is an original effect rather than measured venue motion. Zero depth leaves audio unchanged. Controls are smoothed and retained with an outgoing convolution tail when Spillover is enabled. IR source bytes, shape/damping diagnostics and isolated IR audition exclude this outer processor. Dry output is unchanged; interpolation can colour high frequencies. Older projects restore depth 0 and rate 0.3 Hz.

Transitions > Spillover retains outgoing prepared Studio spaces, Studio Plate characters, Vintage, spatial, ambient, echo-room, Convolution, Spring, Shimmer and Nonlinear tails through type changes. New excitation goes to the selected type, while old tank settings drain; outgoing Hold releases to the stored decay. Wet, timing and ducking still apply to the combined return. Dry level does not increase with overlapping tails. Re-entering a retained tank continues its history. Off keeps the original short crossfade, and older states restore Off. Legacy Studio/Plate engines still crossfade. Spring/Shimmer/Nonlinear keep separate outgoing settings and gated predelay histories; held Shimmer releases to its stored decay while pitch feedback continues. Retained tails have finite deadlines and fade before suspension; switching Spillover off cancels retention. IR replacements still use their own kernel crossfade.

Studio Room/Hall/Chamber/Church/Ambience, Studio Plate, spatial room/hall and Shimmer have a Hold tab. Freeze excludes new excitation; Infinite adds it to the sustained tail. Each type remembers its mode, and dry routing remains independent. Hold off restores decay and motion. Shimmer sustains the unpitched tank while held and resumes pitched feedback on release. Older Shimmer states start with Hold off. Internal bounds prevent unchecked accumulation; these original hold behaviors do not establish commercial sound equivalence. Other modes retain their existing controls; the four ambient modes already provide Off/Infinite/Freeze.

Vintage hall and Vintage random now have an independent Tank rate menu in Colour & motion: Host, 24 kHz or 48 kHz. The lower rates are capped at the device rate. Each runs the complete tank with rate-correct timing and filtered conversion; the existing Converter menu still controls the wet-return colour. Rate changes crossfade and follow Tail spillover. Older projects use Host.

New Plate instances use Studio plate, a dedicated algorithmic tank with Compact, Classic and Expansive timing characters. The Plate tab contains the engine selector, character, Decay, Pre-delay and Diffusion; Tone & motion contains Damping, Low/High Cut, Modulation and Freeze. Decay specifies nominal undamped decay; damping and modulation can shorten the measured high-frequency tail. Freeze stops new excitation and holds the tank, while output filters still apply. Older states retain Legacy until Studio plate is selected. Size and Early level are hidden for Studio plate because they do not apply. This is not a physical EMT or commercial-reference emulation.

Spring uses dispersive feedback delays; Shimmer uses an eight-line feedback network with two tunable pitch voices. In Routing, choose Tank for repeated shifting in feedback, Input for a single pitch stage before the tank, or Input + Tank for both independent stages. Shimmer amount controls their pitched contribution. In Voices, Pitch A and Pitch B span -24 to +24 semitones; Voice B blend crossfades from A only (0%) to B only (100%). New instances use spectral Dual voice processing. Older states retain Legacy octave; select Dual voice in Routing to enable the tunable voices. Nonlinear provides Ramp, Gate, Reverse, Swell, Decay, Gaussian, Swoosh and Bounce reflection envelopes with a 0.1-2 second Duration. Feedback repeats the early reflection pattern and Diffusion softens its input. Late reverb adds a separate Level and 0.1-20 second nominal Decay after the reflections. The timing guide shows only the early envelope; feedback and late reverb can extend the actual tail. Older states retain Tank routing, Ramp, zero feedback/diffusion and zero late level. Changes are smoothed, and settings survive type switching, presets, undo and Compare. These are original algorithms, not qualified BigSky emulations. Irrelevant controls are hidden.

The three new types crossfade over 50 ms; their guide describes timing rather than measuring the audio. Send selects wet-only output and turning Send off restores the preceding wet/dry balance. Mix Lock preserves routing and wet/dry settings on preset recall. Type changes, remembered settings and routing changes are undoable. The graph remains a timing guide, not a measured impulse response.

The Timing & ducking tab is shared across types. Tempo sync replaces the manual Pre-delay with nineteen divisions from 1/64 through sixteen quarter-note beats, including triplet/dotted choices; timing follows host tempo (10-300 BPM, retaining the last valid tempo or 120 BPM before one arrives). The actual milliseconds and BPM appear beside the ducking readout. Synced timing delays the combined wet return, capped by the prepared Delay capacity; dry audio stays immediate. Manual predelay retains its original 0-500 ms input-side behavior. Timing changes glide over 100 ms and sync toggles crossfade over 50 ms, so changes can produce a pitch glide. Duck depth (0-24 dB) attenuates only the wet return using a linked stereo peak detector, a 5 ms attack, Threshold (-60 to 0 dBFS) and Release (20-2000 ms). Reduction ramps from zero at Threshold to full depth 12 dB above it. These controls are global across types, and survive presets, undo and Compare. Older states disable both additions. This is not Raum predelay feedback or full reference-feature parity.

Shared Timing & ducking offers divisions through sixteen quarter-note beats. Delay capacity selects a prepared 6-, 24- or 96-second stereo buffer; the default is six seconds. Actual delay is capped and reported beside the meters. Changing capacity clears delay history; longer buffers use more memory, shown at the current sample rate. This wet-return delay leaves dry timing unchanged. Spatial input-feedback delays have separate per-type capacities.

Vintage hall/random Colour & motion adds Converter > Legacy/Resampled, remembered separately by each type. Legacy keeps the old host-rate quantization. Resampled gives Early digital a 24 kHz companded 12-bit wet return and Later digital an up-to-48 kHz companded 16-bit return; the rate never exceeds the host rate. Modern stays at the floating host rate. Prepared input/output filters and causal reconstruction add a few milliseconds to the converted wet path, with 50 ms switching fades; dry timing is unchanged. With Tank rate set to Host, the tank stays at host rate and existing colour filters remain active. This is an original converter effect, not a measured vintage unit. Old projects restore Legacy; outgoing Vintage spillover retains its converter setting.

Convolution retains its original eighth position in the type selector. It works immediately with one original generated room IR; Load IR accepts non-silent mono, stereo or four-channel WAV, AIFF or FLAC, 8-384 kHz, up to ten seconds. Four channels provide true stereo: LL/LR/RL/RR, or LL/RL/LR/RR, selected explicitly in Channel order. The first letter is input and the second is output. Stereo files keep independent left/right paths; they do not contain cross-channel measurements. Original samples stay embedded in projects, presets, Compare and undo, so moving or deleting the file does not break recall.

The Convolution **Shape** view offers Start, End, Attack, Size (0.5-2x) and Reverse. Processing crops the original IR, applies a 10 ms end fade when shortened, reverses if selected, then resizes with antialias filtering and applies the envelope. Size changes both timing and pitch; it is not an independent decay control. The processed IR can reach twenty seconds. **Balance** adjusts Direct, Early and Tail from -60 dB (mute) to +12 dB using user-defined time boundaries and 2 ms transitions. Boundaries are relative to the cropped/reversed response and scale with Size; these are time windows, not automatic acoustic event detection. Attack is measured after resizing. Normalize is on by default, preserves relative path balance, and can compensate overall gain changes; turn it off for absolute IR amplitudes. The graph shows the actual processed amplitude envelope, normalized for display, rather than frequency response or perceived loudness.

Convolution source import, Apply IR edits and Default room show preparation stages and a Cancel preparation button. The previous response stays active until publication. Successful cancellation retains the prior IR and creates no undo entry; unapplied shape edits remain available. Reading, validation and size conversion check cancellation during their work; decay analysis and playback-kernel preparation may finish the current stage first. Cancellation becomes unavailable once publication starts. Progress indicates stages rather than estimated completion time. Project/preset/full-state recall is not cancellable through this dialog.

Convolution Tail enhancement adds an original synthetic wet tail. Amount defaults to 0 (unchanged); Low/Mid/High decay set nominal 0.1-20 s losses in three separate feedback networks. Tail bands sets the input splits; the effective high split is at least twice low and below Nyquist. Width also applies to the added tail. Decay describes the added network, not the measured combined room response. The source IR, shape/decay graphs and isolated audition exclude this outer synthesis. Tail enhancement can lengthen the audible return, but cannot reconstruct missing room detail or frequencies. It retains settings through type changes and outgoing Spillover, and participates in Undo, Compare and project/preset storage.

Convolution **Bright** adds a prepared synthetic high-frequency response following the applied early/tail energy. Brightness (x) is 0-1 and defaults to 0 (unchanged). It starts after Direct end scaled by Size, follows a causal 10 ms energy envelope and fades at the response end; it does not extend the IR. At 1, the added noise response has half the original early/tail RMS before Normalize. The fixed high-pass corner is 3 kHz or 20% of source rate, whichever is lower. This is an original synthetic addition, not reconstruction of missing venue detail. It cannot produce frequencies absent from the incoming audio. Apply prepares the combined response; its waveform, decay diagnostics, normalization and isolated audition include Bright. Original source samples remain embedded unchanged.

Four-channel IRs also expose **Sources**. Left/Right source blend each range from 0 (recorded left source) to 1 (recorded right source); defaults 0/1 retain the original true-stereo matrix. Each input interpolates the two recorded source columns while retaining both output microphones. This supports both Channel order choices. Cross terms acts on the blended matrix and Normalize acts on its combined response; opposed measurements can cancel. These controls require Apply and share cancellation, Undo/Redo/Compare and portable state with other IR shaping. They do not calculate a new geometric location or work as a stage positioner. Mono/stereo IRs ignore saved source blends.

Convolution Decay offers optional Analyze octave bands: ten separate base-10 octave filters, nominal 31.5 Hz to 16 kHz. Each reports diagnostic T20/RT60, its filter method, or a reason it cannot estimate reliably. Bands beyond the source rate, insufficient decay/noise margin, and decay shorter than filter ringing are unavailable. Analysis runs during preparation and does not change the audio. It is not a certified room measurement. Four-path IRs also have Position: enter measured XY coordinates for the recorded sources and microphones, then requested source coordinates (metres). Defaults are illustrative. Direct placement changes only the Direct interval using distance-dependent delay and bounded gain; measured reflections stay in place. A displayed common causal delay preserves relative arrivals when a requested path would be earlier. Size must be 1 and Reverse off; source-column blends are inactive while placement is enabled. Drag or arrow-key requested markers, or type coordinates, then Apply. Coordinates, analysis preference and embedded source audio share Undo/Redo, Compare and portable state. This is an original direct-path approximation, not a new measured room position.

Convolution > Balance > Output layout defaults to Stereo sum. With a four-channel IR, Four outputs sends LL to left to Main L and RR to right to Main R, with RL to right and LR to left on auxiliary 3/4. Route that pair using a track send. Cross terms scales the cross pair. Adding the pairs recovers the existing true-stereo matrix, before independent destination processing and send gain/pan. The four-path IR channel-order selector is unchanged. This is a declared matrix-path split, not an arbitrary surround or 2-input/4-speaker room renderer. Mono/stereo IRs retain stereo-sum behavior. Long IRs use non-uniform FFT tail partitions without adding output latency.

Convolution **Damping** adds independent Low/Mid/High tail attenuation. Each value is 0 (unchanged) or 0.1-20 seconds for an additional 60 dB decay envelope; smaller values damp more strongly. This is additional damping of the recorded tail, not a measured room decay or a way to lengthen missing audio. For example, a clean exponential 2 s tail with an additional 2 s envelope has a 1 s combined decay. It begins at Early end after Size scaling, preserving samples before that boundary. Low/High split set the three frequency regions; High split must be at least twice Low split. Splits are limited below the source IR's Nyquist frequency. Offline complementary zero-phase bands can redistribute reflection transients after the boundary. The waveform includes damping. Normalize can change overall gain after damping; disable it to preserve absolute amplitudes.

Convolution **EQ** contains a low shelf, two bells and a high shelf, each with frequency and +/-12 dB gain. Bells also offer Q (0.3-6). **EQ On/Off** bypasses all four bands without losing values; **Flat EQ** clears their gains in the draft. These are standard minimum-phase peak/shelf filters, not a circuit emulation. Frequency clamps below playback Nyquist; the graph is calculated from the actual applied coefficients at the displayed playback rate. It shows these four EQ bands only, excluding the IR spectrum and separate wet Low/High Cut controls. EQ runs after convolution/IR normalization, on wet audio only; boosting EQ therefore remains audible with Normalize on. The IR waveform does not include this downstream EQ. Its filter ring-out is included in the reported processor tail. EQ-only edits preserve the sounding convolution tail and crossfade prepared filter banks over 50 ms. They do not rebuild the IR or interpolate coefficients on the callback.

Edits remain a draft until **Apply IR edits** (or Enter); one Apply makes one undo step. Escape or **Revert edits** discards the draft. These prepared-IR edits belong to full state, not scalar parameter automation. FFT preparation runs off the audio callback, and all four paths switch together over 50 ms; existing tails crossfade rather than spilling over for their full duration. Invalid files/settings leave the current response intact. Older states restore neutral shaping and their existing end trim. Pre-delay, Low/High Cut and Width remain available. **Default room** restores the one supplied response; no sample pack is required.

**Ambient reverb modes:** Rising space uses a 0.01-5 s Rise on the wet return, or on both input and dry audio. A 50 ms quiet gap rearms the next swell; the existing tail continues during that gap. The linear rise has a 3 ms smoothing stage. Bloom field sends an eight-stage build-up section into a separate reverb tank: Bloom length sets its 0.02-2 s length scale, and Bloom feedback independently extends that section. This scale is not an exact onset or overall decay time. Cloud field uses a longer input-diffusion cascade and tank, with 1-50 s nominal tank decay and motion focused on the input diffusion. Vowel hall adds three resonant bands with AH/OH/OO, paired sweeps or deterministic random morphs, plus Mild/Medium/High resonance. It is an original filtered reverb, not a sampled or synthesized choir.

All four have independent memories, Size/Diffusion, motion depth/rate, bass-decay ratio, damping and wet cuts. Infinite removes tank decay while allowing new excitation; Freeze also blocks excitation and stops delay modulation after its fade. Stored tank states are bounded during accumulation. Neither hold mode promises a mathematically unchanging waveform, and changing size can retune a held tail. With Spillover Off, a 50 ms type fade ends the previous mode. Spillover retains the wet return and releases outgoing Hold to its stored decay. Nominal tank decay excludes build-up/diffuser tails and is frequency-dependent when bass/damping/motion are active. Host tail reports are capped at 120 seconds. Legacy types and their stored settings retain their previous paths.

Magnetic Heads adds Hold with Freeze or Infinite input policy. It preserves the echo history through a single integer-length lossless return while the multi-head output and output tone remain active. Time, head-count and spacing edits wait for release; normal feedback and motion return on release. Infinite retains the existing bounded overload clamp. This is an original looping policy, not a tape-machine model.

**Magnetic heads and Positioned room:** Magnetic heads offers three, four or six playback taps. Last head time sets the last repeat (200-1500 ms); Even spacing divides that time equally and Uneven uses an original nonuniform pattern. Feedback, limited to 98%, comes from the last head or the final two in Uneven mode. Diffusion softens the taps and Wow and flutter adds two speeds of motion. Damping/filters progressively shape feedback and the wet output; zero Damping bypasses that tone stage. A +/-2 internal feedback bound controls overload, without claiming magnetic saturation.

Positioned Room Hold circulates the captured excitation through the current reflection pattern. Freeze rejects new wet excitation; Infinite adds it. Room size, shape, source position and damping changes wait for release. Output cuts and width stay active, and the positioned dry signal stays live. Releasing Hold restores finite decay; Spillover releases outgoing Hold before draining. This repeats an original finite reflection pattern, not a measured room response.

Positioned room is a finite geometric reflection model with Square/Wide/Long shapes, approximately 9.3-92.9 square metres of area and independent source left/right/front/back controls. The diagram shows the source and fixed listener; moving the source also changes dry panning and distance attenuation. It computes 124 image paths per channel with distance/order attenuation. Stereo input stays separate; this is not binaural/HRTF processing or a measured venue. Damping reduces wall reflection strength and darkens the return. There is no tank Decay control. Geometry glides over 100 ms, which can shift pitch during movement. Both types retain existing timing/ducking, independent memories, Send, Mix Lock, Undo and Compare. Manual predelay feeds the effect; shared tempo sync delays its wet return. Type changes crossfade over 50 ms with Spillover Off; enabling it retains the outgoing wet tail. Long echo tail estimates are capped at 120 seconds.

**Plate colour and chorus:** Studio plate adds Input, Motion and Wet EQ views. Input high pass is a 12 dB/octave filter before Input drive; its 20 Hz endpoint bypasses it. The original asymmetric colour stage affects both the dry and wet signals and compensates by the inverse drive gain; it is not measured loudness matching or a tube-circuit model. Set Wet to zero to use the input stage alone. Drive zero is a colour bypass. Chorus applies only to the wet branch, before or after the plate; Chorus amount blends up to 50% delayed signal with independent stereo motion. Plate Modulation still moves the tank delays independently. Wet EQ provides low/high shelves, +/-24 dB with 20-2000 Hz and 200-20000 Hz frequencies. Its switch bypasses both shelves. Neutral/off defaults preserve older plate audio. Input/chorus/EQ controls are hidden in Legacy and inactive in other reverb types. Parameter changes smooth and full-state Undo/Compare/presets retain these settings. The optional Modal engine below adds original physical dispersion. Measured character/transducer responses, native-rate drive aliasing and listening acceptance remain open.

**Modal plate (development):** Plate engine > Modal selects an original simply-supported rectangular tensioned plate. Geometry sets Length, Aspect ratio, Tension speed, Bending coefficient and a 256/512/1024 mode budget. Exciters positions mirrored left/right inputs; Pickups moves independent left/right velocity pickups. Position controls range from 0.02 to 0.98 of each dimension, with Y measured down the diagram. These preparation controls clear this plate's tail and are not automatable. Decay/Damping, wet filters, Width, preamp, chorus, shelves, Hold and Spillover remain available; Studio-only Character/Diffusion/Modulation are hidden. Freeze excludes new input, Infinite accepts bounded new energy. The finite bank runs at up to 24 kHz and can contain fewer modes when geometry pushes resonances above its limit; higher budgets use more CPU and add upper resonances. It can sound tonal and is not a calibrated EMT/material model. Existing projects and new-instance Studio defaults remain unchanged. Project/preset/Compare/Undo retain the new engine and geometry.

**Spatial reverb types:** Contour room and Open hall use distinct feedback networks with early taps inside their delay lines; Dense changes the scattering, and Freeze holds the network. Diffuse loop places six modulated allpasses per channel inside an echo-feedback loop: each repeat becomes more diffuse, and Feedback sets its repeating tail. It has no separate Decay, Dense or Freeze control. These are original designs, not NI Raum emulations. Each type remembers its own input-delay, feedback, sync, division, density, modulation/rate and Reverb amount controls, as well as its standard space settings.

Input echoes provides 0-2000 ms manual delay or tempo subdivisions through four bars. The prepared synchronized limit is **6000 ms**; slower/longer requests show the effective delay and an explicit cap notice. Integer taps avoid interpolation loss at steady times, with 50 ms crossfades when the time changes. Low Cut and High Cut filter incoming audio and feedback repetitions; their 20 Hz / 20 kHz endpoints bypass the respective filter. Room/hall echoes can repeat unchanged at 100% feedback below the feedback limiter when both filters are bypassed. Diffuse loop retains its diffusion and damping inside the loop. Reverb amount blends direct echoes and space output. The shared Ducking controls remain available. Switching types gives a 50 ms crossfade; it does not retain a full-length tail from the previous type. Inactive modes suspend and invalidate history without clearing their full buffers on the audio thread. Infinite/very long tail estimates use a finite 120-second horizon; extend or trim exported tails deliberately. Subjective density/colour and hardware matching remain unverified.

Spatial Input echoes adds Input delay capacity, saved independently for Contour room, Open hall and Diffuse loop. Choose 6, 24 or 96 seconds; old projects keep six. Changing capacity clears only that space's tail. Existing synced divisions through sixteen quarter-note beats use the selected capacity; the diagram shows actual delay and any cap. Manual Input delay retains its 0-2000 ms range. Larger capacities use more memory, and the diagram estimates all three prepared delay buffers together (up to about 442 MB with all three at 96 seconds/192 kHz). This capacity is separate from shared wet-return Delay capacity. Configuration changes are not automatable; project/preset/Compare/Undo and type memory retain them. Feedback tails remain conservatively bounded at 120 seconds for host reporting and outgoing spillover.

Dispersive Spring adds a dedicated Hold tab. Freeze sustains the stored sound and excludes new input; Infinite keeps adding input. Hold suspends propagation loss, damping and motion. Saved spring-count, Tension and Dispersion edits take effect on release. Output tone stays active. Outgoing Hold releases to the stored decay when Spillover is enabled. Legacy Spring retains its existing behavior.

**Dispersive Spring (development):** Spring engine selects Legacy or the opt-in Dispersive model. Existing projects and current defaults retain Legacy. Dispersive provides one/two/three parallel bidirectional springs, Clean/Combo/Tube/Overdrive input dwell, 0.8-10 s nominal Decay, Tension, Dispersion, Motion and +/-10 dB Low end. Tone retains damping and wet cuts; Timing & ducking retains predelay and ducking. Size/Diffusion and the old generic Freeze control are hidden because they do not control this model. Tension changes propagation time and resonance spacing; Dispersion changes arrival time by frequency. Parameter transitions can retune the tail. Dwell is applied before the tank; Tube/Overdrive use original native-rate saturation, not a calibrated valve circuit. Nominal decay includes allpass group delay at 1 kHz before additional damping; decay at other frequencies differs. This is an original digital model, not a measured spring or commercial emulation. Switching engines/types crossfades for 50 ms with Spillover Off. With it enabled, Dispersive Spring retains its saved settings and drains before suspension.

**Vintage low-band decay (development):** Vintage hall and Vintage random add Bass decay (0.25-4x) and Bass crossover (100 Hz-10 kHz) in Tone. Each mode remembers its own values. The multiplier sets the asymptotic low-frequency decay target; damping, crossover, interpolation and motion can shorten or reshape measured band decay. Default 1x retains the previous signal arithmetic. Longer bass tails extend the host-tail estimate and dormant engine draining. This does not add converter emulation or establish commercial sonic equivalence.

Inactive Spring, Shimmer, Nonlinear and Convolution processing drains before suspension. Returning after suspension starts without replaying input received while the type was inactive. IR and EQ edits made while Convolution is inactive are ready when it is selected again. All these prepared engines can retain their outgoing wet tails with Spillover. IR replacements still use their own kernel crossfade.

The development checkout adds **Vintage hall** and **Vintage random**, among standalone Reverb's 41 types. Both use an original nested-allpass stereo tank: Hall uses continuously moving chorus taps, while Random crossfades stationary randomized taps and uses longer diffusion sections. Space controls Size, Diffusion and nominal Decay. Colour & motion provides Early digital, Bright digital and Clean, Motion depth (0-1) and Motion rate (0.05-2 Hz). Early digital combines an 8 kHz bandwidth limit, coarse modulation resolution and companded output quantization; Bright digital uses 16 kHz and finer resolution; Clean removes quantization. The actual wet bandwidth is also limited by High Cut and the playback sample rate. Colour bandwidth/output changes fade over 50 ms. These treatments do not reproduce any commercial converter or internally downsample the tank. Tone provides Damping and wet cuts. Each type remembers its own controls; Timing & ducking and wet/dry routing remain shared. Freeze and Early are not available for these types. Size and motion changes can shift pitch. Inactive tanks drain on silence and suspend; Spillover can retain the outgoing wet tail through type changes. Older projects retain their existing type. The other reference modes and listening acceptance remain open.

**IR audition (development):** Convolution's **Audition** tab offers Audition IR with Impulse or an 80 ms Noise burst, sent to Both, Left or Right inputs. It plays a snapshot of the applied IR, shape/damping/normalization and wet EQ through the Master level/pan/mono, bypassing FX chains and outer reverb Mix/predelay/cuts/ducking. Apply or Revert pending edits first. One audition plays at a time; Stop cancels queued preparation or fades playback over 10 ms. Closing/changing the editor, window blur, device changes, source removal and expired editor heartbeat stop it. Preparation progress is shown between stages; an in-progress FFT preparation finishes before cancellation is observed. Preview peak is capped at 0.25 (-12.04 dBFS) without boosting quiet responses; any attenuation is reported. Tails are capped at 24 seconds with an end fade. The preview is output-only and is not part of track processing or offline export. Device-level routing and subjective quality still need audition acceptance.

**True-stereo cross terms (development):** Four-channel IRs expose Cross terms (x) in Balance. 1 retains the full true-stereo matrix; 0 removes Left-to-Right and Right-to-Left paths while preserving Left-to-Left/Right-to-Right paths and their normalization. Apply smooths the gain over 50 ms without resetting the convolution tail. Undo, Compare, presets and embedded portable state retain it; older states use 1. Mono/stereo IRs ignore it. The displayed source envelope excludes this downstream gain; IR audition includes it. This is crossfeed control, not acoustic source positioning.

Convolution's read-only **Decay** view displays the applied IR's backward-integrated broadband energy after Early end. When the tail passes conservative checks, Estimated RT60 extrapolates a -5 to -25 dB line fit; the shaded region is that fit interval. Silence, short tails, high endpoint energy and inconsistent decay show an unavailable reason. This diagnostic sums channel energies and excludes wet EQ, cross-term gain and outer Reverb controls. It does not certify an acoustic measurement or synthesize a longer tail; edits still happen in the other IR views.

Convolution **Decay > Band** selects Broadband, Low, Mid or High. Low/Mid/High use the applied Damping splits (the displayed limits account for source sample rate), with separate curves, fits and rejection reasons. These overlapping broad filters are not octave-band measurement filters. Leakage, ringing, noise and trimming can bias the diagnostic. **Audition** is now a separate IR tab; leaving it stops the preview. The IR tabs wrap within the checked 620x720 and 980x580 layouts.

#### Limiter, gate and saturation

**Saturation engines:** Legacy retains the earlier Tape/Tube/Transistor/Clip/Crush/Console/Transformer/Foldback voices. Flux, Valve sag, Iron memory, Console slew and Push-pull are original frequency- and history-dependent voices, not calibrated commercial or hardware emulations. Dynamics controls their memory contribution. Input trim and Boost (+20 dB) feed Drive; Estimated compensation applies an explicit -0.42 dB per positive driven dB estimate, not measured loudness matching. The nominal reference is a -18 dBFS peak sine. New engines put Low cut and Tilt before saturation, offer a Corner bump at the cut frequency and a post-saturation High cut with 6/30 dB slopes. Input, output and driven-peak readouts distinguish level positions. Quality retains Off/2x/4x and delay-aligned Mix; changing quality can change reported latency. Engine changes fade through aligned dry. Legacy restores the old post-filter and compensation behavior and hides new controls; NAM embedded processing does not consume these additions.

**Limiter response:** Classic preserves the previous processing. Swift, Balanced and Sustain are original two-stage responses, with separate fast peak handling and slower recovery. Recovery exposes Slow attack, Release and Auto recovery; Channel links controls transient/safety linking separately from the slower envelope. Both links at zero allow independent channels, while 100% shares the strongest reduction. Auto recovery lengthens release after sustained reduction. These are not emulations of commercial limiter styles. Maximize off in the new responses applies no makeup gain; Maximize on scales toward Ceiling. True Peak remains independently protective per channel. Response changes blend over 10 ms; Off quality retains 20 ms latency, while oversampling adds conversion and output-guard delay. Older states recall Classic. Measurement pause/reset does not alter the audio response.

**Limiter gain workflow:** Gain workflow offers Link threshold & ceiling and Unity audition. Link moves both controls by the same dB amount in one undo gesture, stopping when either reaches its existing range limit. It links editor gestures; host automation remains independent. Unity audition smoothly removes the applied makeup gain while keeping limiting active, for judging reduction without the level boost. It does not match perceived loudness. Both controls are stored in presets/projects/Compare and default off for older states.

**Limiter measurement:** Integrated loudness and Loudness Range accumulate complete K-weighted windows while Measuring is active. Pause/Resume excludes paused audio from I/LRA; current momentary, short-term and peak readings continue. Reset clears the measurement, its maxima and recent output/reduction display. LRA is marked provisional during the first 60 measured seconds. These measurements are temporary and are not restored by project/preset/Compare. The fixed 0.01 LU histogram approximates gate boundaries and percentiles; full EBU certification is not claimed. This addition does not change limiter gain processing or add final-export dither.

**Gate and Expander (development):** Gate retains the existing binary open/hold/close behavior. Mode > Expander selects continuous downward expansion with Ratio 1-10, Knee 0-12 dB and reduction limited by Range. Attack/Release smooth applied gain; Hold/Hysteresis are Gate-only. Detector retains Peak/RMS/Auto, HPF/LPF and rate-correct timing. Detector Listen outputs that filtered stereo signal exclusively, independent of Mix, with a 20 ms transition. The main view shows the actual detector level and envelope stage. All new settings support automation, Undo, Compare and project/preset recall; older states choose Gate with Listen off. Detector integration adds to the displayed gain timing. External keys are selected separately as described above; upward expansion is not part of this mode.

#### Preamp, graphic EQ and alignment

**Align tracks (development):** Add Gain Phase to two to eight related tracks, open Align tracks, choose a reference and select the group. Play a continuous section with looping off, then Analyze inputs. Review the L/R delay and polarity proposals before Apply group. Hear before/Hear aligned auditions the whole group; editor Undo/Redo restores all members together. Analysis captures the selected duration at each utility input, before its own controls but after upstream FX. All members are delayed to the latest arrival, so the reference can receive delay. Apply replaces timing/polarity, enables processing and uses the accepted optional all-pass fit, otherwise turning manual phase rotation off; gain stays unchanged. Weak/repetitive signals, changed controls, missing members and excessive delay spread reject the operation. Match is a correlation heuristic, not confidence in acoustic correctness. Independent L/R can change stereo arrival differences; Stereo linked applies one common offset/polarity and preserves the captured input timing relation. Downstream FX/PDC are excluded; the separate Spectral FIR option is described below. Capture/group selection is temporary; applied controls retain ordinary project/preset/Compare storage. Live-device and listening qualification remain open.

Align tracks Capture offers Short (up to 0.5 s), 2 s or 4 s. Longer captures compare beginning, middle and end windows, each limited to 65,536 samples. All three must be measurable, agree in polarity and have lags within one sample; individual lags appear in the result. This catches changing offsets and inconsistent sections. Short capture retains its 65,536-sample limit, so it is shorter than 0.5 s at high sample rates; the actual duration is shown. At least 4,096 samples are required: at an 8 kHz device rate, choose 2 s or longer because the half-second option is rejected before capture. Capture buffers are prepared before recording and retained for reuse. Changing duration invalidates a proposal; changing sample rate during analysis or before initial Apply rejects it. Undo/Redo clears stale proposal/audition status. Group selection and analysis preferences are temporary; applied controls keep normal project storage.

Gain Phase > Align tracks adds optional Fit all-pass phase. After a timing estimate passes its existing confidence checks, it searches the existing one-corner filter (one to four first-order stages) and a small timing adjustment. Broadband coherent evidence must improve in both capture halves; Stereo linked applies a common filter and rejects a fit that worsens either measurable channel. The result shows the corner/stages and phase agreement, or why time-only was retained. This percentage is a heuristic, not a probability of acoustic correctness. Analysis leaves audio unchanged; Apply group replaces manual phase settings with the fit or Off, and before/aligned audition and Undo/Redo restore the complete group. This bounded original fit is not arbitrary spectral correction or proprietary reference emulation. Downstream FX/PDC and listening/device qualification remain outside the analysis.

**Saved spectral phase alignment (development checkout)**

In Gain Phase > Align tracks, Phase correction offers Timing only, All-pass fit and Spectral FIR. Select related existing instances, choose the reference and play an uninterrupted section with looping off. Spectral FIR learns a frequency-dependent correction from one capture half and checks its rendered response against both halves. Weak, inconsistent or narrowband evidence keeps a unity curve; the accepted timing/polarity proposal remains available. The displayed phase agreement and ripple describe measured evidence, not acoustic correctness. Listen before accepting the result.

Apply group saves the curve in every selected instance, disables the previous manual all-pass rotation and enables spectral processing. The reference receives a unity curve. Editor Undo and Hear before/Hear aligned restore the whole group. Each enabled instance reports 2,304 samples of latency to the host, including when bypassed. Spectral > Correction scales the saved phase curve; Spectral phase switches the FIR on/off while retaining the curve. The graph shows requested phase, which the finite FIR approximates. Copy L to R / R to L includes the saved curve. Presets, Compare and project state retain it; older sessions default Off. Downstream effects, changed routing and whole-song group discovery are not analyzed.

**Long alignment spans (development):** Gain Phase > Align tracks > Capture offers 30/60/120 s in addition to the short 0.5/2/4 s choices. Long spans retain three native-rate windows at the beginning/middle/end, each up to 65,536 samples; stereo storage is at most 1.5 MiB per instance, or 12 MiB for eight. Playback must remain uninterrupted through the gaps. Every measured section must agree in polarity and within one sample; silence or ambiguity can reject the proposal. These modes use timing/polarity only; choose up to 4 s for an all-pass or Spectral FIR fit. The result distinguishes elapsed span from retained audio. Cancel analysis or leave the panel to abort without changing audio; native progress and a six-second editor heartbeat protect abandoned captures. Unmeasured gaps are not evidence of agreement.

**Find related groups (development):** Check two to eight existing Gain Phase instances, or use Select available to check up to eight, then play and choose Find related groups. This timing/polarity scan uses the captured audio, not track names. Every pair and lag/polarity cycle must qualify, so unrelated sources, silence, inconsistent timing or weak bleed can remain unmatched. Choose a discovered group to review its member/channel results, then Apply group; only that group changes. Undo/Redo restores the whole applied group. Unmatched inputs retain their settings. Use group for analysis checks its exact members and reference for a subsequent phase fit. The selected reference is preferred when part of a group; others use the strongest measured aggregate relationship. Discovery proposals are temporary and invalidate after input settings or history changes. This conservative workflow does not analyze a whole song, infer unmeasured bleed relationships or create DAW track groups.

**Separate utilities:** Preamp provides oversampled input drive, colour and output trim using an original nonlinear transfer. Graphic EQ provides independent ten-octave and 31-third-octave gain banks, selectable Stereo/Left/Right/Mid/Side targets, optional 12 dB/octave low/high cuts, output trim and a Flat bank action. The 31-band bank uses Low/Mid/High pages. Select frequency labels to group bands; dragging a selected fader or applying an Offset changes the group with one Undo step. Flat bank resets only the active bank. The response graph uses the native filter coefficients for the selected target and includes output trim; pre/post spectra use stereo energy in dBFS, so opposite-polarity channels do not cancel. Analyzer Off hides the spectrum. Both banks and cuts survive presets, Compare and project recall; old projects keep the ten-band bank with cuts off. The display offers 6/12 dB ranges. The display automatically expands to show gains outside the smaller range; changing the display range does not alter audio. Gain Phase provides gain/boost, polarity, integer Delay plus Fine (0-0.999 sample) for each channel, independent all-pass Phase L/R and live output stereo correlation. Timing L/R tabs keep deliberate delay separate from phase rotation; Phase tabs expose an enable, Corner and 1-4 stages. Each stage rotates 90 degrees at its corner with unity settled magnitude. Copy L to R / Copy R to L copies timing, polarity and phase as one Undo action. Fine uses causal cubic interpolation: upper-band magnitude/phase differs from an ideal delay. All controls retain existing state/Compare behavior; old states restore Fine zero and Phase off. Manual-view stereo correlation is not reference-track confidence. These are independent FX-chain entries.

Preamp also offers a **Tone EQ** switch, defaulting off in new and older states. Low & high contains a low shelf (Off/35/60/110/220 Hz, +/-16 dB) and a fixed 12 kHz high shelf (+/-16 dB). Mid & filter contains a bell (Off/360/700/1600/3200/4800/7200 Hz, +/-18 dB) and an 18 dB/octave high-pass filter (Off/50/80/160/300 Hz). Switching a band Off hides its unused gain control and retains the value. Tone EQ bypasses all four sections while retaining settings. These original digital filters run after colour and before output trim, with 10 ms control transitions and unchanged oversampling latency. They approximate the stepped workflow, not measured analogue circuit curves; Legacy retains the existing colour model; Original stages is a separate opt-in choice.

Preamp's **Saturation reference** shifts the digital level at which its colour curve acts, from -24 to 0 dBFS peak. Zero preserves older projects. Lower values add colour sooner while keeping small-signal Drive/Output gain; Colour zero stays linear. Input/output readouts show sample peaks and sine-peak-calibrated averages before Input drive and after Output trim. Driven peak is measured relative to Saturation reference. This reference is neither a hard clip ceiling nor an interface dBu setting; the preamp is an original approximation.

Gain Phase **Align tracks > Channels** defaults to Independent L/R. **Stereo linked** proposes one delay and polarity for both channels of each instance. Both measurable channels must agree in polarity and within one sample; a silent/insufficient partner uses the disclosed usable channel, while conflicting or ambiguous estimates disable Apply. This retains the captured input's L/R timing. Apply replaces existing manual timing/polarity, and editor Undo or Hear before restores the complete prior group.

#### Delay and modulation

**Delay Multi/Dual (development):** Mode offers Digital, Tape, Analog, Multi and Dual. Multi alternates four weighted heads between channels; Topology changes their spacing and Head feedback controls the shared loop. Dual runs A and B in parallel with independent feedback. B timing sets its time ratio (0.5-1), motion and Topology (B blend and stereo spread); B tone controls its feedback filters/saturation. The diagram shows target timing ratios, not a measured echo response. Motion exposes optional Custom wow plus flutter; leaving Custom wow off retains mode-dependent wow. Ducking adds attack, release and maximum reduction. Diffusion blends a four-stage wet diffuser after the main repeats; Span sets its total delay from 5 to 200 ms. It adds smear after the displayed repeat time and does not compensate the main delay or change its feedback. Amount zero is the default and preserves the earlier audio. Amount/Span changes are smoothed; turning Amount fully off discards the diffusion tail after the fade. Sync keeps the existing note divisions. New controls support Undo, Compare and preset/project recall. Older states keep their three-mode interpretation and defaults. The extended lines are prepared even in the three old modes; those modes retain exact tested output. These are original delay topologies, not commercial emulations.

**Modulation sync and modes (development):** Chorus/Flanger/Phaser now keep manual Rate in Hz separate from Sync Cycle length (straight, triplet and dotted choices). Old synced states map to their previous duration. The running-rate readout uses the actual smoothed LFO rate; the drawn wave is schematic. Flanger exposes Voices; Phaser exposes Stage pairs (2-12 stages, with fractional pairs blending adjacent even counts) and hides unused Spread. Last valid tempo is retained when the host supplies none, initially 120 BPM. Existing unsynced defaults and audio remain unchanged.

#### Instruments and pitch

The audition keys and pads use separate instrument voices in the live monitor/master route. They do not enter track MIDI recording or offline export. The clone follows the instrument controls without sharing its note ownership. Hold with the pointer or **Enter**, then release; blur/close fades out the preview. Four editor leases can coexist; a five-second heartbeat timeout recovers interrupted sessions. Preview does not include the track's FX chain.

**Synth independent filter envelope (development):** In a non-Legacy Filter mode, Envelope source selects Amp or Independent. Independent adds Filter attack (0.1-5000 ms), decay (1-5000 ms), sustain (0-100%), release (1-10000 ms), and velocity depth. These five settings latch on the next note; the source selector blends over 20 ms. Envelope amount remains +/-4 octaves. MIDI sustain delays filter release, which starts from the current level; the amplitude envelope still determines when the voice becomes silent. Older states retain Amp. All settings participate in Undo, Compare, presets and isolated audition.

**Project-span alignment and routing (development):** Alignment Capture > To project end continuously analyzes the audio from the current playback position to the last project clip, with 8 seconds to 30 minutes remaining. Start playback near the beginning to cover the arrangement. Every captured sample reaches a bounded worker queue; its audio storage is independent of arrangement length (up to 3.5 MiB per stereo member), with small worker windows and summary evidence. Queue overflow, missing chunks, cancellation, seek or changed routing invalidates the result. The 30/60/120-second choices retain their explicitly sparse capture. At least six windows and 75% of measurable windows must qualify; contradictory qualified delays or polarities reject the proposal. Allow weak shared signal uses repeated timing evidence and stronger peak separation. Routing defaults to captured inputs only. Direct master requires Gain Phase last in track FX, master enabled, matching output ranges and no enabled sends. Fixed-latency master allows downstream track FX and accounts for their reported latency and track polarity. It requires the same direct master path, with no send/feedback route. Changes in route, FX order, bypass or reported latency invalidate capture or stale Apply; Apply and Undo retain route guards. Downstream frequency-dependent phase, nonlinear effects and unreported plugin latency remain outside this timing correction.

**Expanded Synth destinations (development):** The Synth Matrix now offers 28 destinations on every route, including pan/brightness, both envelope stages, filter envelope depth/key tracking, LFO rate/depth, separate oscillator tuning/shape and pulse widths. Timing and rate offsets are multiplicative; waveform positions crossfade adjacent shapes. Pulse-width modulation affects the square component. Envelope/LFO timing routes use the previous sample to avoid a same-sample feedback cycle. Existing automation lanes retain their old ranges; the editor uses appended full-range destination lanes.

**Live guitar strings (development):** Play > Performance shows the processor's current string voices, latched articulations and held, pedal-held or releasing state. Assigned marks the voice currently assigned to that string; previous releases can appear alongside it. Next notes shows the panel selection and per-channel keyswitch overrides. Idle means no current voice in the snapshot. Note names precede bend/slide, and coupled-body resonance tails are separate. Unavailable feedback is shown explicitly rather than retaining old voices. These live performance values are not preset state.

**Guitar articulations (development):** Guitar Articulation (Plucked loop only) offers Sustain, Palm mute, Harmonic, Hammer/pull, Legato slide, Slide in, Slide out, Dead note and Pop. Harmonic node chooses divisions 2-6; Slide time controls slides. Hammer and legato reuse the vibrating history of an overlapping note on the same string; releasing the source note does not stop the destination. Without an eligible source they pluck normally. Optional keyswitches MIDI 24-32 latch these choices per channel and take precedence over the menu until CC121 or transport reset. Legacy does not consume keyswitch notes. Slide-out key 30 also starts the exit slide on sounding strings. These are original synthesized articulations.

**Secondary coupled instrument bodies (development):** Piano and Guitar have an optional Coupled body panel. The existing voice drives a secondary network of string and body modes: Piano has 88 string fundamentals plus eight body modes; Guitar has 24 open-string partials plus eight body modes. String coupling exchanges energy inside that network; it does not feed back into the primary voice engine. Body decay is the nominal open-damper time to -60 dB (0.2-8 seconds). Piano held keys, CC64 and captured CC66 notes control string damping. Each MIDI channel owns its tail and level/pan; CC120 clears only that channel. Coupled body defaults to zero, preserving the original response. This is an original linear model with unmeasured body frequencies, not a measured physical instrument or sampled library.

**Guitar plucked loop and chorus (development):** String > Engine selects Legacy additive synthesis or Plucked loop for new notes. Nominal decay spans 0.2-8 s before damping and palm-mute losses. Pick position and hardness shape each new excitation; pickup position, damping, Body and palm mute stay live. Body adds two original resonances, not a measured guitar body. Existing string-channel routing and bends apply to both engines. Chorus adds an independent stereo delay modulation (12 ms base, 0-6 ms depth, 0.05-5 Hz); Stereo motion remains the earlier pan modulation. Old states retain Legacy and zero delay-chorus mix. Undo, Compare, presets/projects and isolated keyboard audition include all controls. Prepared string memory is about 2.5 MB at 48 kHz and 9.8 MB at 192 kHz. Sampled instruments, coupled strings, hardware qualification and listening acceptance remain open.

**Independent plugin outputs (development, October 3):** Drums > Piece > Piece output assigns each of eight pieces exclusively to Main 1/2 or an auxiliary stereo pair from 3/4 through 17/18. Select a pad or Drum piece first. In Track routing, create a send to a destination track and choose the matching Source channels. The destination can have its own FX and stem render. An unassigned pair is silent. Following stereo FX process the main pair while retaining auxiliaries; track gain, pan and pre/post-fader send choices apply to their selected pair. Old states restore every piece to Main 1/2. Project save/reopen, full plugin state, Undo and Compare retain routing. Isolated keyboard/pad audition intentionally folds the audition clone back to stereo without changing project routing. Stereo Freeze rejects tracks with enabled auxiliary sends; render the destination buses as stems instead.

**Drums piece controls and mapping (development):** Select a pad or Drum piece to edit its level, tuning and pan offset. Tuning spans +/-12 semitones for pitched components (including kick sweep); noise is unchanged. Pan offset is added to the existing piece position, clamped left/right, then scaled by Width. Tune/pan transitions take 20 ms. The mapping guide reports the native MIDI input-to-voice translation for the selected piece and current GM/Roland TD subset. It also identifies same-channel hat closure and supported poly-pressure chokes. Other notes retain synthesized fallback percussion. Pointer and Enter audition select the piece. All pieces survive Undo, Compare, automation and project/preset recall; old states default tune/pan to zero. The historical Velocity Curve is preserved: positive values soften response, negative values harden it, and zero retains exponent 1.135. These are synthesized drums; recorded articulations and sampled room ambience are not included. Custom input maps are described below.

Drums keeps Legacy voices by default. Performance > Voice engine > Articulated enables original synthesized side-stick/rim/centre drums, tip/edge and graduated hats, bow/bell/edge/muted cymbals, tom rims and auxiliary percussion. Extended studio is an additional input map; it is not a sampled library. The eight mixer groups share Level, Tuning, Pan offset and 0.1-4x Decay in the Piece tab. Decay scales envelopes and pitch fall. Articulation pads switches between two pages of eight isolated audition pads. Edit MIDI map remaps any of 128 incoming notes before the chosen map, or ignores it. Learn input selects a new incoming note; it does not save a change. Apply map saves the complete draft as one Undo step. Closed/pedal hats and poly-pressure chokes remain channel-local, and remapping does not change a ringing voice's input ownership. Extended studio leaves unassigned notes silent; GM/TD retain fallback percussion.

**Piano expressive performance (development):** Strike > Performance > Expressive applies to new notes; Legacy remains the default and older-state route. Velocity curve changes touch response, Strike colour changes upper partials/hammer transients with strike velocity, and Release velocity changes damping speed from note-off velocity. The performance choice and strike colour are retained by each sounding note. CC64 progressively lifts dampers; Damper curve controls the partial-pedal release law. CC66 captures notes already held on that MIDI channel, while later notes release normally. CC67 softens the sound by Soft pedal depth. Pedal values smooth over 10 ms, and accumulated natural decay avoids retrospectively increasing tail gain when a pedal moves. Re-pedalling can slow a surviving release but cannot revive a dead voice. Resonance remains synthesized; the separate Coupled body panel adds an optional secondary string/body network. All six settings support Undo, Compare, automation and project/preset recall.

**Synth filter and LFO (development):** Filter defaults to Legacy brightness processing. Low pass, High pass and Band pass select an original 12 dB/octave voice filter with Cutoff 20 Hz-20 kHz, Resonance Q 0.5-12, Key track rooted at MIDI 60, and Envelope up to +/-4 octaves from the amplitude ADSR. Cutoff is limited to 45% of sample rate and the internal 10 Hz-20 kHz range after modulation. Key track at 100% follows one octave per octave of notes. LFO offers Sine/Triangle/Saw/Square, 0.05-20 Hz, depth and Off/Cutoff/Pitch/Amplitude routing. Each note resets its LFO phase; full depth reaches +/-4 octaves of cutoff, +/-2 semitones of pitch, or amplitude down to silence. Cutoff routing needs a non-Legacy filter. Mod-wheel vibrato remains separate. Independent filter ADSR and the eight-route Matrix are described in this section. New settings support Undo, Compare, automation and project/preset recall; older states retain Legacy with LFO off.

**Pitch detection source/confidence (development):** Detection > Detect from selects Left, Right or Mid (L+R)/2; older states retain Left. Mono always uses its only input. Mid can cancel opposed stereo channels. Detection remains monophonic and correction stays linked across stereo. The confidence meter and brighter/dimmer history strip display the detector estimate, not a probability of musical correctness or a rating of correction quality. Changing source resets detection and releases generated MIDI notes while retaining the audio delay. PitchDetector now uses fixed analysis scratch storage and atomic history publication; it no longer allocates each analysis frame or blocks audio processing on the history reader.

MIDI seek retains bank/program, registered parameters, controllers, pitch bend and channel pressure set by earlier clips, even after those clips end. Reset and pedal ordering are preserved. Only notes belonging to a clip containing the seek position are restarted; ended pedal-held notes are excluded. Imported paired releases extending beyond the clip are cropped to its end, and note-offs on an exact clip/block boundary still play. Seeking reconstructs bounded controller/note state, not prior voice envelope age.

Basic Synth, Piano, Clean Guitar and Drums respond to channel CC7 Volume, CC10 Pan and CC11 Expression with 5 ms smoothing. Volume and expression multiply as linear amplitude controls before bus protection. Defaults retain unity volume/expression and centered pan. Pan biases each instrument's existing stereo position toward the selected edge; Synth uses unity-center equal-power stereo gains and ignores pan in mono. Guitar's stereo delay chorus follows this voice pan. CC121 restores expression while preserving volume and pan; processor reset or state recall restores defaults. Synth MPE multiplies manager/member levels and applies manager pan to member positions; a manager reset restores its zone's expression. These transient performance values are excluded from presets and Compare. High-resolution controller pairs and master-volume SysEx are not implemented.

Basic Synth and Clean Guitar support MIDI CC66 sostenuto alongside CC64 sustain. Sostenuto captures keys held when the pedal goes down; later notes are not captured, and repeating Down does not capture them. Either pedal can hold a released note until both relevant holds end. Synth MPE retains manager and member pedal ownership separately. CC121 resets pedal control and releases unprotected notes; All Sound Off silences voices immediately. A stolen/reused voice does not inherit an earlier latch. Guitar string reassignment still damps the previous string voice. Piano keeps its existing Expressive sostenuto behavior.

MIDI seeking restores overlapping notes on the same key in first-in, first-out order, including sustain/sostenuto-held notes and original release velocity. Channel state persists from earlier clips, but ended clips do not restart their notes. The activity display remains active until the last held instance of a repeated key is released. Notes restart their envelopes when chased; old voice age and receiver-specific allocation cannot be reconstructed from MIDI 1.0 channel/key events alone.

**Pitch Correct:** dry and wet paths use the full streaming delay, processor bypass retains that delay, zero strength does not retain pitch smoothing, and formant controls reach the shifter. Select Custom scale to enable individual target notes. MIDI generation releases its previous note on disable, bypass or channel change. Basic Synth, Piano, Clean Guitar and Drums now allocate independent repeated-note voices, with sixteen voices per MIDI channel, deterministic stealing and channel-local All Sound Off. Synth, Piano and Guitar support sustain and FIFO matching of repeated-note releases. Guitar retains its string-channel allocation. Closed/pedal hi-hats and cymbal aftertouch choke drum tails over 4 ms. Reset clears voices and controllers. Basic Synth adds an ADSR envelope and A / B oscillator blend; old states without Sustain retain full sustain. Drums provides eight piece-level controls selected from the pads or Drum piece selector. Guitar's existing pan modulation is labeled Stereo motion. These remain synthesized instruments and require no sample packs. Subjective sound quality and commercial-reference fidelity are not established by the deterministic checks.

Synth Matrix now offers eight routes on two pages and four smoothed global macros. Source/Destination/Amount controls support Undo, Redo, Compare and project/preset recall. Destinations include Cutoff, Pitch, Level, Oscillator blend, Detune, Sub, Air and Resonance. Added destinations sum within +/-35 ct, +/-0.8 sub, +/-0.25 air and +/-4 octaves of Q, then clamp to safe voice ranges; Cutoff and Resonance require a non-Legacy filter. Macro 1-4 values run from 0 to 1 and can feed multiple routes. Each macro also supports Off or CC0-119 and Any or one MIDI channel in MIDI learn. Learn controller observes the next new CC and saves its number/channel together with one Undo step; Cancel or leaving the tab stops capture. Incoming values temporarily override the saved knob with matrix smoothing, and do not consume the CC's other functions. The MIDI target readout distinguishes this live position from the saved base value. Manual knob edits, relevant CC121 and processor reset return to that base. Presets, project state and Compare retain mappings/base values, never live controller positions. New routes/macros default Off/zero. Original route automation ranges remain unchanged; expanded selectors use appended automation IDs. Source/destination/controller/macro changes smooth over 20 ms. Arbitrary parameter routing remains open. Matrix LFO uses Shape/Rate and its own Amount even when the direct LFO Destination is Off. Shared free run is independent of transport; Per note remains the default. Matrix only disables legacy wheel vibrato/brightness. LFO and MPE slide are bipolar; the other sources are unipolar.

Basic Synth Oscillators adds independent Saw, Square, Triangle and Sine selectors for A and B. Shapes crossfade over 20 ms without resetting phase. Old states retain Saw A and Square B. A / B blend keeps the original gain recipe, and Sub & noise retains the sine sub oscillator and transient air controls.

MIDI playback and seek chase use one stable timeline across overlapping clips. Later controller, pitch and pressure values take precedence by event time; equal timestamps retain clip/event insertion order. This also preserves MPE configuration ordering before chased expression and notes. Known-baseline relative RPN and the per-channel seek behavior below are supported; repeated same-key voices remain unqualified.

MIDI seek now restores independent per-note pressure, orders bank selection before its program, and applies controller reset before later expression. Sustain-held notes and the sostenuto capture set are reconstructed, including released keys; pedal release, All Notes Off, All Sound Off and controller reset clear the corresponding ownership. This restores MIDI state rather than elapsed voice envelopes. Current chase reads clips spanning the seek point; standalone earlier controller clips are not reconstructed. Repeated voices on the same channel/key, half-pedal acoustics, device-specific Omni behavior and MPE manager-wide custom pedal/reset behavior remain unqualified.

Synth MPE accepts RPN 0 Data Increment/Decrement (CC96/97) in one-cent steps within the 0-96 semitone range. MIDI seek can reconstruct relative RPN 0-4 changes after explicit absolute values; include zone configuration before those starting values. Sequences without a known baseline and manufacturer-specific NRPN increments remain unsupported. Runtime RPN values are replayed from MIDI, while presets retain the editor configuration.

**Synth MPE (development):** MIDI expression defaults to Legacy MIDI. Select MPE zones to enable lower (master channel 1) and upper (master channel 16) zones; their member channels extend inward. Changing either member count shrinks the other zone when necessary. Bend ranges separately set each zone's note/master spans, 0-96 semitones, default 48/2. Configuration edits stop current voices and are not automatable. Keep the track MIDI channel on All. Member bend adds to master bend; pressure adds and clamps to 0-1, and CC74 slide adds around center 64 and clamps to -1/+1. Select Channel pressure or MPE slide in Matrix and set Amount/Destination to hear those dimensions. Master CC1 and sustain apply across the zone. Member reuse starts with neutral dimensions unless new expression arrives before the note; release tails retain the prior member values. RPN 6 changes zones and RPN 0 changes bend range, including cents; these runtime messages are replayed from MIDI while presets/Undo/Compare retain the explicit editor settings. Seeking reconstructs the 64 most recently changed absolute RPN/NRPN values before expression/notes. Relative RPN 0-4 requires the explicit baseline described above; conflicting overlapping parameter clips and hardware-controller compliance are not qualified. The isolated audition keyboard chooses a member channel when a zone is active.

### 9.4 Plugin Hosting

OpenStudio hosts third-party plugins for effects and virtual instruments. VST3 is the most mature path. CLAP and LV2 code paths are present and exposed in current builds where the plugin format is available, but individual plugin compatibility may vary more than VST3.

**Scanning for plugins:**
1. Go to the FX Chain Panel or Plugin Browser.
2. Click **Scan** to scan standard plugin directories for installed plugins.
3. Scanned plugins appear in the plugin list organized by manufacturer and category.

On Linux, LV2 bundles containing multiple plugins list each plugin separately.
Rescan after installing a compatible plugin or changing its search folder.

**Adding a plugin:**
1. Open the FX Chain Panel for a track.
2. Click the **+** button or "Add Plugin".
3. Browse the plugin list (filterable by name, manufacturer, category).
4. Click a plugin to add it to the chain.
5. The plugin's native editor window opens automatically.

**Plugin editor windows:**
- Native plugin editors open in separate native windows when the hosted plugin exposes an editor.
- Parameters can be adjusted in the native editor or via the FX Chain Panel's parameter list.

**Separate process (Windows):** eligible external plugins expose **Separate
process (crash protection)** in the Plugin Browser. This per-plugin preference
is saved on this computer and applies on the next load, including reopened
projects; existing instances keep their current mode. The browser shows the
added latency. This mode supports up to 32 active audio channels and 16 buses per direction, requires a
reload after bus-layout changes, and does not support ARA integration. It is
not currently exposed on macOS/Linux and does not guarantee compatibility with
every plugin. The installed Kontakt 7/8 layouts exceed these limits and are
rejected in Separate process mode. Normal in-app hosting passed host-parameter
Read and JUCE gesture-capture checks on empty instances in both FX chains; loaded
libraries and physical vendor-editor controls remain unqualified.

An **Audio fault** indicator means processing was stopped after an error. For an
isolated plugin, open its editor and choose **Restart worker**, or remove/reload
it. For a processor running inside the app, bypass and re-enable it to retry,
or remove/reload it. Consult the crash diagnostics log if the fault returns.

### 9.5 Plugin Presets

**Saving presets:**
1. Open the FX Chain Panel.
2. Adjust the plugin parameters to the desired settings.
3. Click the preset save icon.
4. Enter a preset name.

**Loading presets:**
1. Open the preset browser for the plugin.
2. Select a previously saved preset.
3. The plugin parameters are restored.

### 9.6 A/B Comparison

For VST3 plugins, OpenStudio supports A/B comparison:

1. Set up your "A" settings.
2. Switch to the "B" slot.
3. Adjust parameters independently.
4. Toggle between A and B to compare settings by ear.

### 9.7 FX Bypass

Bypass all effects on a track without removing them:

- Click the **FX Bypass** button on the track header.
- The FX button indicator changes from green (active) to red (bypassed).
- Individual plugins can also be bypassed within the FX Chain Panel.

### 9.8 FX Chain Reordering

Drag an effect's grip handle onto another loaded row within a track, input or
master FX chain to change its order. Signal flows from top to bottom, and the
same order is applied to native audio processing. Dropping outside the chain or
cancelling leaves the order unchanged. Hold the pointer near a list edge to
scroll through a longer chain. Focus the grip handle and press **Up** or
**Down** to move an effect one position with the keyboard. Reorder, Undo and Redo
retain the plugin's envelopes; master FX use their persistent instance identity.
MIDI Learn mappings follow track/input reorders. Removing a mapped FX retires
its mappings; removal Undo restores them along with the saved plugin.

### 9.9 Safe Mode (Bypass FX on Load)

If a project with heavy or problematic plugins is slow to load, open it in Safe Mode:

- **File > Open Project (Safe Mode)...** (`Ctrl+Shift+O`)
- All FX plugins are bypassed on load, allowing the project to open quickly.
- You can then selectively enable plugins as needed.

### 9.10 NAM Rack

**OpenStudio NAM Rack** is the built-in Guitar/Bass workspace for NAM A1/A2
pedal, amp, and full-rig captures.

1. Add **OpenStudio NAM Rack** from the built-in effects list and select the
   live instrument input.
2. Choose **Guitar** or **Bass**. The profile changes appropriate hidden
   tracking/frequency voicing and library filtering without replacing the
   current capture, IR, or visible control values.
3. Load a local `.nam` file, or connect TONE3000 and open a tone pack.
4. If a pack contains multiple captures, choose **View Captures**, select the
   exact child capture, and check its topology badge. **RAW / AMP ONLY** needs
   an external cabinet IR; **CAB EMBEDDED** is a full rig and bypasses the
   external cabinet stage while preserving the selected IR for later.
5. **Selecting** a row changes only the pending choice. **Audition** temporarily
   routes that capture through live input. Audition another child to compare,
   or choose **Stop**/Cancel to restore the previous rack state.
6. Choose **Use** to commit that exact capture. Reopen the capture selector and
   use another child to replace it.
7. Use the Amp power control to bypass/enable the capture without unloading it,
   or use **Unload** to clear the slot. The immediate rack recovery card handles
   missing Amp/Cab assets with Locate, Replace, and Bypass. Project-open
   missing-media recovery also covers Pedal NAM assets and can offer Search in
   Folder, a library copy, Locate, and supported TONE3000 Re-download.
8. Save a rack tone or project to recall the complete creative state. Device
   calibration remains local playback-environment state rather than silently
   travelling as part of a tone.

Factory effect templates contain control settings only: they do not include a
NAM capture or cabinet IR and use the Amp/Full-Rig that is already loaded.
Exported rack presets reference local NAM/IR files instead of embedding those
binaries, so another machine may require Locate, Search, or supported
Re-download recovery.

Local `.nam` loading works without TONE3000. Public-build TONE3000 availability
depends on the partner-approved integration and release configuration. On
Linux, sign-in also requires `secret-tool` (usually installed by the
`libsecret-tools` package) and an available Secret Service/keyring.
Closing a detached window cancels its pending credential requests, including
when another window is waiting for a slow or unavailable keyring. A credential
error still needs the keyring service to be restored before sign-in can succeed.

**TONE3000 presentation, development checkout, October 8, 2026:** the capture/IR
library displays the official logo, connected account identity, creator avatars,
artwork and NAM/IR format. The compact **Browse** button followed by the T3K logo
stays available in the library header; its accessible name is **Browse TONE3000**.
The account avatar uses initials when no image is available: a circle such as
**AD** identifies the signed-in account. The header and controls adapt to the
window size, leaving more height for the scrolling tone list. Creator, license,
instrument and character filters still apply to loaded results.
In compact library views, open **Selected · details & actions** to reach the
selected tone's capture controls; loading captures opens it automatically. The
library tabs scroll horizontally when the host is narrow.
Signed-out users choose **Continue** in the community introduction, then
sign in and select a tone on TONE3000. The returned pack opens for capture
selection; **Audition** and **Use** still control the rack change. **Favorites**,
**Created**, and **Downloaded** are online account collections. **Installed** and
**Local Favorites** are local views, and result stars save local favorites.
Loaded tones show a T3K source mark and retained artwork when available; clicking
the attribution reopens details. This update describes the development checkout
and is not a released-feature or partner-approval claim.

The mixer's **Monitor FX** picker includes built-in effects such as EQ, Gain Phase,
Reverb and NAM Rack, together with installed effect plugins. Instruments are
excluded from this output-only chain. Use it for a listening
or practice rig: monitoring effects are excluded from rendered exports. Put the
rack on a track FX chain when you want its processing in that track's render.

Audition and Use/Cancel are transactional, and prepared model swaps reject
stale requests. Perceived click/noise behavior on a real interface is still a
release audition item, especially at small buffers; automation alone is not a
substitute for listening to the exact build.

See the [NAM Rack guide](nam-rack.md) for the complete signal chain,
Guitar/Bass mapping, state migration, TONE3000 connection, and QA contract.

---

## 10. Automation

### 10.1 Automation Overview

Automation allows parameter values to change over time. OpenStudio supports automation for:

- Track volume, pan, stereo width, mute and trim volume.
- Pre-FX volume, pan and width on instrument and bus tracks.
- MIDI velocity, pitch bend, channel pressure and CC envelopes on MIDI/instrument tracks.
- Master volume, pan, mute and trim volume.
- Send level, pan and mute, addressed by destination track.
- Eligible master and monitor FX parameters in the master's envelope panel. Monitor FX affect listening only and are excluded from export.
- Host-exposed parameters of track FX, input FX and the dedicated instrument plugin.
- Eligible controls in EQ, Graphic EQ, Compressor, Gate, Limiter, Preamp, Saturator, Reverb, Delay, Chorus, Gain Phase, realtime Pitch Correct, Basic Synth, Piano, Clean Guitar, Drums and NAM Rack. The fallback instrument exposes 12 scalar/choice controls. Model/IR file selection, instrument type, calibration, presets, MIDI mapping and processing configuration are not automation parameters. The graphical Pitch Editor edits a clip's working audio copy and does not use parameter envelopes.

This describes unshipped development-checkout behavior. Native VST3 editor gestures feed the same writer as the generic FX sliders, including plugins running in isolation. Eligible JSFX numeric/choice sliders have stable slider IDs; file selectors remain excluded. Scripts must use `slider_automate()` to report an edit for recording. CLAP values, gestures and active/inactive flush are integrated; protocol fixtures and selected vendor editor-window cycles pass; broader CLAP compatibility remains plugin-specific. Parameter rescans refresh names, choices and eligible targets. Compatible JSFX/CLAP targets retain their lanes; removed targets or changed meanings retain their points as unavailable lanes. An isolated plugin that changes parameter IDs, automation meaning or audio-bus layout requires a worker reload. Display-name changes within an unchanged contract refresh without faulting the worker. A control must be exposed to the host: Kontakt libraries such as One Kit Wonder may need a Kontakt host-automation assignment. Komplete Kontrol exposes its mapped controls, not necessarily every nested instrument control.

AmpliTube 5 exposes sixteen assignable DAW parameter slots plus bypass. Assign the desired amp or pedal knob to a DAW slot in AmpliTube's Automation panel, then choose that slot in OpenStudio's envelope panel. The host cannot automatically turn every internal AmpliTube control into a separate envelope.

### 10.2 Showing Automation Lanes

1. Click the automation disclosure triangle on a track header, or right-click and select "Show Automation".
2. Automation lanes appear below the track in the timeline.
3. Select which parameter to display from the lane dropdown.

In the envelope panel, **Visible** shows a lane without enabling **Read**. **Show last touched** reveals the last eligible control edited in a plugin. Plugin lanes retain their parameter name, native range, units and choices; compatible older generic labels refresh without replacing custom labels. Master/monitor FX use persistent instance identities across reorder, undo and project reopening.

### 10.3 Drawing Automation

1. Show the automation lane for the desired parameter.
2. Click on the automation lane to add a point.
3. Click and drag to draw multiple points.
4. Drag existing points to adjust their position and value.
5. Delete points by selecting them and pressing Delete.

Continuous automation points use straight segments matching native interpolation. Eligible switches and choices use stair steps and hold their previous value until the next point. Manual points snap to known choices. Plugin point tooltips request host-formatted values; unavailable formatting falls back to an explicitly normalized percentage. VST3 and CLAP Read delivery uses SDK sample offsets where supported, including isolated VST3 transport. Native plugin output events retain SDK offsets when supplied. Ordinary GUI edits use an estimated native transport timestamp, and other controls retain their block/control-rate path; every mouse gesture is not sample accurate. Capture uses a bounded ordered queue. Stop halts audio immediately, then drains pending built-in editor writes before committing the pass and moving the playhead. The native drain waits at most 1.5 seconds; a stalled editor reports a warning to check the final envelope value.

### 10.4 Automation Modes

Use the track's **R** and **W** buttons for Read and Write. They also work before any lanes exist. Enabling Write enables Read; disabling Write leaves Read enabled. Read can be disabled independently. With Write enabled and playback or recording running, moving an eligible control creates its lane and records points. Stopped edits change the saved plugin state without creating automation.

| Mode      | Description                                                                  |
|-----------|------------------------------------------------------------------------------|
| **Read**  | Automation plays back. Manual parameter changes are temporary.               |
| **Write** | Arms controls for recording while the transport runs, using the project's write behavior below. |
| **Touch** | Records automation only while the user is actively touching a control. Reverts to existing automation on release. |
| **Latch** | Like Touch, but after release, continues writing the last value until transport stops. |
| **Touch/Latch** | Track or master volume follows Touch; other eligible controls follow Latch. |
| **Cross-Over** | After release, keeps writing; retouch and cross the original curve to return to Read. |
| **Overwrite** | Writes armed lanes continuously while the transport runs, replacing the traversed data. |

Choose a behavior in the envelope panel's **Write** selector. This setting applies to the project; track and master R/W gates remain independent. An empty plugin lane does not reset its knob. Read reclaims a manually changed knob when a populated curve plays. Explicit editor gestures and generic FX sliders remain touched until release; a slider's native value echo cannot end its held gesture. Value-only edits without gesture notifications use a short inactivity timeout for Touch. Cross-Over uses the original curve from the start of the write pass. It latches after release; retouch and move through that original curve to stop writing. Without that second-touch crossing it continues until Stop. A complete write pass is one undoable edit.

With the **Cubase keyboard profile**, **F6** opens the envelope panel for the selected track (first track or master as fallback), **Alt+R** toggles Read for all tracks and **Alt+W** toggles Write for all tracks. On macOS use **Option**. A mixed selection of on/off states is switched uniformly off before the next press enables all. Master R/W has its own controls. Custom overrides and active editor scopes can change the effective shortcuts; see **Options > Keyboard, Mouse & Trackpad**.

Save the project after changing plugin knobs. Saving obtains fresh native state for input FX, track FX and instruments; reopening restores it into the corresponding plugin instance. Missing plugin identities stop a save instead of shifting saved states onto another slot. A failed plugin load or rejected state is reported. Removing an FX closes its open editor and removes its automation; undo restores the FX and its saved state/lanes. Reordering FX keeps lanes with their plugin.

Failed loads retain the plugin identity, saved state and automation. Stop transport and use the unavailable-FX retry controls after making the plugin available. Successful restoration reattaches compatible lanes and is undoable; incompatible targets keep their points without controlling another parameter. If a CLAP plugin explicitly clears a parameter's host references, the old lane is archived as unavailable and requires a new lane. Undo cannot silently reattach those cleared references. A clear-all request also removes matching MIDI Learn references.

Drag a loaded FX row's grip handle to another row in a track, input or master chain to reorder native audio processing. Cancelling or dropping outside the chain leaves the order unchanged. Reorder, Undo and Redo retain the plugin's envelopes and track/input MIDI Learn references.

Master/monitor FX Undo and Redo suspend old envelope routes and resolve saved SDK parameter identities against the restored plugin before Read resumes. A rollback resolves the current stage's identities again too. Changed or removed controls retain inactive envelopes. If plugin state or Automation Safe protection cannot be established during rollback, Save is blocked until the original project is reopened; the displayed chain cannot establish the native state after that failure.

If a master/monitor chain edit succeeds but its resulting state cannot be captured for Undo, OpenStudio restores the previous chain, envelopes and Safe protection and reports the failed edit. A failed restoration blocks Save. Native FX changes requested during an offline export or Freeze wait for that transaction to finish while the window continues processing input.

Saved MIDI Learn controls follow their original track/input FX when missing plugins compress the live chain. Unavailable controls stay with the retained FX settings across Save/reopen. Retry restores compatible controls without replacing CC assignments made while that FX was unavailable; reassigned controls must be relearned. New saves include the host parameter identity and meaning when available. Older mappings fall back to their saved parameter index. Rapid track-FX Undo/Redo finishes each native operation in order, and queued work from a replaced project is discarded.

**Touch return** selects an immediate return or a 100 ms–5 s ramp back to the original continuous curve after release during playback. It requires an existing curve; discrete controls and stopped edits return immediately. The complete pass, including its ramp, is undoable. **Automation Safe** on a plugin section prevents recording for all its eligible parameters; existing Read playback and manual editing remain available. Both settings are saved in the project. Monitor FX state is saved with the project too.

### 10.5 Automation and Clip Movement

The **Move Envelopes with Items** option (Options menu) determines whether automation points move when their associated clips are moved:

- **Enabled**: Automation points follow clip movement.
- **Disabled**: Automation points stay in their original time positions.

### 10.6 Automation Value Ranges

| Parameter | Frontend Range | Backend Range          |
|-----------|---------------|------------------------|
| Volume    | 0.0 - 1.0    | -60 dB to +12 dB      |
| Pan       | 0.0 - 1.0    | -1.0 (L) to +1.0 (R)  |
| Mute      | 0.0 / 1.0    | Off / On               |

The frontend stores normalized values (0-1) which are converted to native units when sent to the backend.

### 10.7 Clearing Automation

- Delete individual points by selecting and pressing Delete.
- Clear all automation for a parameter: right-click the lane > "Clear Automation".
- Via Lua: `openstudio.clearAutomation(trackId, parameterId)`.

### 10.8 Envelope Range Tools

Select a lane in the current track or master envelope panel and stop transport, then expand **Envelope range tools**. **Trim range** offsets points in normalized parameter space; **Fill range** sets a value over the timeline time selection; **Thin lane** reduces continuous points across the lane with a chosen maximum vertical error (0–5% of range). Boundary guards preserve the curve outside a range, including the initial manual value when filling an empty lane. Stepped controls support Fill with known choices. **Preview edit** displays the original and proposed curves without changing playback. **Apply edit** commits one undoable change and rejects a stale preview.

### 10.9 Realtime Trim

Expand **Realtime Trim** in the track or master envelope panel. The Trim control adds −60 to +12 dB after the main volume control while preserving the main volume curve. Stopped edits adjust the saved manual offset with one Undo per gesture. **Arm Trim** enables recording of the separate Trim Volume lane during playback or recording; other lanes on that owner remain in Read. The selected write behavior applies to Trim, except that Touch/Latch treats Trim as a Latch control. Stop completes one undoable pass and restores the saved manual offset. Recorded Trim plays through its own Read lane.

**Freeze Trim** is available with transport stopped and Read enabled on both populated lanes. During Read, a populated Trim curve replaces the manual offset. Freeze combines volume with the Trim curve, or the manual offset when Trim is empty, into the volume lane, clears Trim and returns its manual offset to 0 dB, as one undoable edit. Freeze rejects a result outside the volume range rather than clipping it.

The October 6 development checkout also offers a **Trim target** selector for track volume and each send destination. Send Trim applies a separate −60 to +12 dB offset after the send's linear level, including pre-fader sends. Destination IDs keep its lane attached when sends are reordered. Coalescing approximates the product of linear level and dB Trim within 0.00001 linear gain, and rejects overload or excessive point counts while retaining the separate curves.

Choose the project-wide **Coalesce Trim** policy while stopped: **Manually** retains the separate curve; **After each pass** merges changed Trim lanes at Stop as part of the pass's single Undo; **On leaving Trim** merges when disarming Trim while stopped. Safe controls, disabled Read, a missing base curve or an out-of-range result prevent that merge and retain the offset. The policy and manual send offsets are saved in the project; older projects default to manual coalescing and 0 dB send Trim.

New saves retain stable parameter IDs and meaning for track/input FX, dedicated instruments, and master/monitor FX Automation Safe controls, including controls without an envelope. Compatible parameter reordering preserves protection. Incompatible protected track/input effects remain unavailable for review; incompatible protected instruments or restored stages stop project restoration and block Save, so they cannot protect a different control. Retry FX recovery also preserves protection through Undo/Redo. Legacy projects without a contract use the saved index unless an existing envelope supplies a stable ID. MIDI Learn restoration verifies native readback, and a failed snapshot or incomplete restore prevents saving over the previous project.

Windows development checks on October 6 found that exporting AmpliTube could reset an exposed normalized parameter; the host now retains that value across export. A separate cold-instance issue remains: the first AmpliTube guitar export differs from later exports despite preserved controls. Repeated wet output for that installed plugin is not qualified. This does not establish the behavior of every vendor plugin or preset.

### 10.10 Audible Preview and Capture

Select an eligible audio or FX lane, disarm Write/Trim, and expand **Audible Preview & Capture**. **Audition selected envelope** holds its current native value independently of its curve. Adjust the Preview control to hear a candidate value; adding another selected lane on the same owner can audition a group. Points remain unchanged. **Capture values** copies the held values for later use. Select a timeline time range, stop transport, and choose **Commit captured range** to fill that range, preserve the curve outside it and commit all captured lanes as one undoable edit.

**Cancel Preview** restores Read or the original manual value while retaining captured values. **Discard capture** clears that temporary copy. Closing the dialog, saving, taking plugin-state snapshots and exporting cancel the live audition. Preview and capture are not saved in the project. Safe, unavailable, locked or MIDI-controller lanes cannot enter Preview; changing a target or its curve invalidates a stale capture. One owner can preview up to 64 parameters at a time.

During playback, **Punch Preview** starts writing only the auditioned controls, holding them until **End Punch** or Stop. It leaves the owner's ordinary Write arm unchanged. Knob/fader changes update the held value. The whole pass, including boundary fills, has one Undo. Safe, Read, target-meaning and lock changes end an invalid Punch. Punch cannot begin during audio recording.

Eligible native and detached plugin-editor controls also update a Punched or AutoJoined parameter when ordinary Write is off. Other parameters remain in Read. Stop retains the final queued built-in editor value even if Read has already resumed.

Expand **Writing & AutoJoin** for **Write to start**, **Write to end** and **AutoJoin latched controls**. Boundary commands require transport running and fill only controls already writing: from zero to the current playhead, or from the playhead to the last clip/envelope point in the project. They preserve the other side of the curve and join the current pass's Undo.

Enable **AutoJoin** while stopped. After stopping a Latch/Touch-Latch or Punch pass, start playback or recording before its actual stop point to read existing curves until that point, then resume the previous held values. The native engine schedules the join within the audio block; the frontend records its exact timeline boundary. Touch controls do not rejoin. A touched pending control is removed from the join. Changed curves, Safe/Read changes, changed targets or a new project invalidate stale entries. A loop must contain the remembered join point; joined controls remain held through later iterations. AutoJoin supports up to 128 controls. Its enabled setting is saved, but the remembered pass and held values are temporary.

If an FX cannot load, its settings and envelopes remain unavailable and later FX retain their own targets. Stop transport and use **Retry** after making the plugin available. Compatible targets can recover on reopening or retry; changed parameter meanings remain unavailable for review. Explicitly cleared CLAP references require a new lane.

---

## 11. Markers and Regions

### 11.1 Markers

Markers are named position indicators on the timeline:

**Adding markers:**
- Press `M` to add a marker at the playhead position.
- Press `Shift+M` to add a marker with a custom name.
- Use **Insert > Marker at Playhead** from the menu.

**Navigating markers:**
- Double-click a marker in the Region/Marker Manager to jump to that position.
- Navigate between markers using the marker controls or via Lua scripting.

**Managing markers:**
- Open the **Region/Marker Manager** (View menu) to see all markers in a list.
- Delete, rename, or reposition markers from the manager.

### 11.2 Regions

Regions define named time ranges on the timeline:

**Adding regions:**
- Make a time selection, then press `Shift+R` or use **Insert > Region from selection**.
- The region is created covering the time selection.

**Region properties:**
- Name
- Start time
- End time
- Color

**Region uses:**
- Define sections of your project (verse, chorus, bridge).
- Use as render bounds (render individual regions to separate files).
- Navigate quickly between sections.

### 11.3 Region/Marker Manager

Open via **View > Region/Marker Manager**. This panel displays:

- All markers and regions in the project, sorted by time.
- Name, position, and duration for each item.
- Controls to edit, delete, and navigate to items.

---

## 12. Rendering and Exporting

### 12.1 Opening the Render Dialog

Open the Render dialog via **File > Render...** or press `Ctrl+Alt+R`.

Hosted plugins receive an advancing export playhead at the selected output sample rate, including tempo changes and integrated quarter-note position. Track Freeze uses the same project-time behavior. The live playhead stays in place. During normal playback, quarter-note position also integrates tempo changes rather than jumping when BPM changes. These clock corrections do not establish cold-start or sound-quality parity for every plugin.

### 12.2 Render Source

Choose the required source. Master and track-stem paths are active; the two
selected-item choices are visible but do not yet filter the backend to the
selected clips:

| Source | Current status |
|---|---|
| **Master mix** | Full mix of all tracks through the master bus |
| **Selected tracks (stems)** | Individual stems for selected tracks |
| **Master mix + all stems** | Master mix plus a stem for every track |
| **Selected media items** | UI choice only; selected-clip filtering is pending |
| **Selected items via master** | UI choice only; selected-clip filtering is pending |
| **Razor edit areas** | Renders each razor-area time range as a separate stem from the track that owns the area |

### 12.3 Render Bounds

Choose the time range to render:

| Bounds             | Description                                    |
|--------------------|------------------------------------------------|
| **Entire project** | From the first clip start to the last clip end |
| **Custom range**   | Manually specified start and end times         |
| **Time selection**  | Uses the current time selection               |
| **Project regions** | Renders each region as a separate file        |
| **Selected regions** | Renders each selected region separately      |

### 12.4 Output Settings

**Directory**: Browse to select the output folder.

**File name**: Enter a filename. Supports wildcard variables:

| Wildcard   | Replacement                       |
|------------|-----------------------------------|
| `$project` | Project name                      |
| `$track`   | Track name (for stem renders)     |
| `$region`  | Region name (for region renders)  |
| `$date`    | Current date (YYYY-MM-DD)         |
| `$time`    | Current time (HH-MM-SS)           |
| `$index`   | Sequential index (zero-padded)    |

**Tail**: Optionally add a tail (in milliseconds) after the end time to capture reverb and delay tails.

### 12.5 Format Options

**Primary output format:**

| Format | Current status |
|---|---|
| **WAV** | Uncompressed output with the available bit-depth selection |
| **AIFF** | Uncompressed output with the available bit-depth selection |
| **FLAC** | Lossless compressed output with the available bit-depth selection |
| **MP3** | FFmpeg-encoded output using the selected bitrate; FFmpeg is bundled on Windows and must be installed on `PATH` on macOS/Linux |
| **OGG Vorbis** | FFmpeg-encoded output using the selected quality; FFmpeg is bundled on Windows and must be installed on `PATH` on macOS/Linux |

**Sample rate**: Select the target render rate. The offline engine renders at
that rate while the playback path converts source files as required.

**Channels**: Stereo or Mono.

**Effective export precision (development):** Primary and secondary PCM exports offer 18-, 20- and 22-bit precision stored in standard 24-bit files. Unused low bits are zero. Quantization happens after normalization, channel conversion and final sample-rate conversion, even with Dither off. Dither modes use the selected effective precision. Queue entries retain each output setting; float output and lossy codec quality settings are unchanged. This does not change recording bit depth.

### 12.6 Processing Options

| Option          | Description                                                      |
|-----------------|------------------------------------------------------------------|
| **Normalize**   | Peak-normalizes the output to 0 dBFS                             |
| **Dither**      | Final integer quantization: flat TPDF, first/second-order shaped TPDF, or lower-noise RPDF |
| **Resample Quality** | UI placeholder only in the current build; backend support is pending |

Dither is applied once, after normalization, channel conversion and final sample-rate conversion, for 16/24-bit integer output. TPDF is the general-purpose choice. Shaped TPDF moves noise toward high frequencies; second order does so more strongly. RPDF has lower noise but its noise level varies with the signal. These are original quantizers, not a proprietary IDR emulation. Floating-point and lossy output disable dither. Queue jobs retain their selected mode, including secondary integer outputs. The limiter does not add a second dither stage. Near full scale, integer saturation can clip the dither; allow output headroom when this matters.

### 12.7 Secondary Output

Enable **Secondary output** to run a second render pass in another format after
each primary file. Select its format and bit depth/codec quality independently.

### 12.8 Metadata

The **Metadata** section is present as a disabled placeholder in the current build. Metadata embedding is planned, but these fields are not written yet:

- Title
- Artist
- Album
- Genre
- Year
- Description
- ISRC code

### 12.9 Post-Render Options

| Option                        | Description                                         |
|-------------------------------|-----------------------------------------------------|
| **Online render (1x speed)**  | UI placeholder only in the current build; currently disabled |
| **Add to project after render** | Automatically import rendered files as new clips in the project |

### 12.10 Render Queue

Instead of rendering immediately, click **Add to Queue** to add the render job to the Render Queue. Open the Render Queue via **View > Render Queue** to manage and batch-process multiple render jobs.

### 12.11 Region Render Matrix

For complex multi-region, multi-format rendering, use **File > Region Render Matrix...**. This provides a grid interface to configure which regions render in which formats.

### 12.12 DDP Export

For CD mastering, use **File > DDP Disc Image Export...** to create a DDP (Disc Description Protocol) disc image suitable for CD replication.

Supply a rendered 44.1 kHz, 16-bit stereo WAV and project regions for the track
markers. The current source checkout filters the source picker to WAV and asks
for an output **folder** when exporting; these picker corrections are in the
unpublished Linux revision 8 candidate. Cancelling folder selection cancels the
export. Validate the resulting disc image before delivery.

---

## 13. Project Management

### 13.1 Saving Projects

| Action              | Shortcut         | Description                              |
|---------------------|------------------|------------------------------------------|
| Save                | `Ctrl+S`         | Save to current file (or Save As if new) |
| Save As             | `Ctrl+Shift+S`   | Save to a new file location              |
| Save New Version    | File menu        | Save an incrementally versioned copy     |

### 13.2 Opening Projects

| Action              | Shortcut         | Description                              |
|---------------------|------------------|------------------------------------------|
| Open                | `Ctrl+O`         | Browse and open a `.osproj` project file |
| Open (Safe Mode)    | `Ctrl+Shift+O`   | Open with all FX plugins bypassed        |
| Open Recent         | File menu        | Quick access to recently opened projects |

### 13.3 New Project

Press `Ctrl+N` or use **File > New Project**. You will be asked to confirm if there are unsaved changes.

### 13.4 Close Project

Use **File > Close Project** (`Ctrl+F4`). If changes exist, you will be prompted to save.

### 13.5 Project Templates

Templates save the project layout (tracks, routing, FX chains, settings) without media for reuse:

**Saving a template:**
1. Set up your project with the desired tracks, routing, and FX.
2. Go to **File > Save as Template...**
3. Enter a template name.

**Using a template:**
1. Go to **File > New from Template...**
2. Select from the list of saved templates.
3. The template's structure is loaded as a new project.

**Managing templates:**
- Delete templates via the **New from Template** submenu.

### 13.6 Project Tabs

OpenStudio supports multiple project tabs:

- **File > New Project Tab**: Opens an additional project tab.
- Switch between tabs to work on multiple projects simultaneously.

### 13.7 Session Archive

Archive your entire session (project file + all referenced media) into a single package:

1. Go to **File > Archive Session...**
2. Select the destination.
3. All media files are copied alongside the project file, ensuring portability.

### 13.8 Media Pool

Media-pool state and menu actions are present, but the full Media Pool panel is
not mounted in the current workspace. Use the Missing Media Resolver for broken
paths and the Media Explorer for browsing/import.

### 13.9 Missing Media Resolver

When a project references audio files that cannot be found at their stored paths:

1. OpenStudio displays a warning on project load.
2. The Missing Media dialog allows you to browse for moved files or point to new locations.
3. Resolved paths are saved with the project.

### 13.10 Auto-Save / Auto-Backup

Configure automatic backups via **Options > Preferences > Backup**:

| Setting             | Description                                          |
|---------------------|------------------------------------------------------|
| Enable Auto-Backup  | Toggle periodic recovery snapshots (off by default)  |
| Backup Interval     | Time between backups (1-60 minutes, default 5 min)   |

Auto-backup writes rotating recovery snapshots when changes are detected,
including for an untitled project. It does not overwrite your saved project or
mark current edits as saved. Use **Save** or **Save As** for a normal project save.
See [interrupted-session recovery](#1316-interrupted-session-recovery) to restore
a snapshot.

### 13.11 Project Compare

Compare the current project state with the last saved version:

- Go to **File > Compare with Saved Version**.
- A comparison view shows what has changed since the last save.

### 13.12 Clean Project Directory

Remove unused files from the project directory:

- Go to **File > Clean Project Directory...**
- The dialog shows which files are unused and can be safely deleted.

### 13.13 Export MIDI

Export all MIDI data in the project:

- Go to **File > Export Project MIDI...**
- A standard MIDI file is created containing all MIDI clips.

### 13.14 Batch File Converter

Convert multiple audio files between formats:

- Go to **File > Batch File Converter...**
- Select input files and configure the output format.
- Convert in batch.

### 13.15 Capture Output

Live capture is an experimental plumbing path in the current build. The menu action exists, but production-ready real-time master-output capture is not part of the stable user workflow yet:

- Go to **File > Capture Output** to toggle live capture.
- Treat this as a development/diagnostic feature until the backend capture path is fully enabled.

### 13.16 Interrupted-Session Recovery

After an interruption, **Recover an interrupted session** offers available
project snapshots, recordings, and AI work. Recovery depends on what reached
disk; it cannot recreate audio lost before it was written.

- **Restore copy** opens a project snapshot as an unsaved copy. Use **Save As**
  after checking it. **Open without plugins for troubleshooting** avoids loading
  instruments and effects; their saved states remain in the original recovery file.
- For an interrupted recording, **Preview copy** repairs complete samples into
  a separate file. **Import recovered audio** adds it to a new or chosen track
  with undo support. Original files are retained; incomplete trailing bytes and
  known dropped samples are reported.
- For completed AI audio, preview/import it or use **Resume original import**
  when the original target is still valid. **Restart generation** starts an
  unfinished request again with its saved settings and seed; it does not resume
  from a sampling checkpoint.
- **Later** postpones recovery. **Dismiss reminder** dismisses the entry while
  retaining files. Recovered recording/AI reminders remain recoverable until an
  explicit project save containing the imported work or dismissal.

If **Recording storage failed** appears during recording, affected takes stop
accepting audio while other tracks and monitoring continue. Stop recording to
finalize the available samples, then check free space and the recording
destination before starting another take.

---

## 14. Scripting

### 14.1 Overview

OpenStudio includes a Lua scripting engine that provides programmatic access to nearly all DAW functions. Scripts can automate repetitive tasks, create custom workflows, and extend OpenStudio's capabilities.

### 14.2 Script Editor

Open the Script Editor via **View > Script Editor**:

- Write Lua scripts in the editor pane.
- Click **Run** to execute the script.
- Output appears in the console pane below.
- Use `openstudio.print(...)` to output messages to the console.

### 14.3 Scripting API Overview

All scripting functions are currently accessed through the legacy `openstudio.*` namespace. Key categories include:

**Track Operations:**
```lua
local id = openstudio.addTrack("Vocals")        -- Create a new track
openstudio.setTrackVolume(id, -6.0)             -- Set volume in dB
openstudio.setTrackPan(id, -0.5)               -- Pan left 50%
openstudio.setTrackMute(id, true)              -- Mute the track
openstudio.setTrackSolo(id, true)              -- Solo the track
openstudio.setTrackArm(id, true)               -- Arm for recording
openstudio.removeTrack(id)                      -- Delete a track
openstudio.reorderTrack(0, 3)                  -- Move track from index 0 to index 3
```

**Transport Control:**
```lua
openstudio.play()                               -- Start playback
openstudio.stop()                               -- Stop
openstudio.record()                             -- Start recording
openstudio.setPlayhead(10.5)                    -- Jump to 10.5 seconds
openstudio.setTempo(120)                        -- Set BPM
openstudio.setTimeSignature(3, 4)              -- Set 3/4 time
openstudio.setLoop(true, 4, 12)               -- Enable loop from 4s to 12s
```

**FX Chain:**
```lua
openstudio.addTrackFX(trackId, pluginId)        -- Add VST3 plugin
openstudio.addTrackJSFX(trackId, "OpenStudio EQ") -- Add built-in effect
openstudio.removeTrackFX(trackId, 0)           -- Remove first FX
openstudio.bypassTrackFX(trackId, 0, true)     -- Bypass first FX
local fx = openstudio.getAvailableJSFX()       -- List built-in effects
```

**Master Bus:**
```lua
openstudio.setMasterVolume(1.0)                -- Set master volume (linear)
openstudio.setMasterPan(0.0)                   -- Set master pan (center)
```

**Sends:**
```lua
local idx = openstudio.addTrackSend(trackId, busId)  -- Add send
openstudio.setTrackSendLevel(trackId, idx, 0.7)      -- Set send level
openstudio.removeTrackSend(trackId, idx)              -- Remove send
```

**Automation:**
```lua
openstudio.setAutomationPoints(trackId, "volume", {
    { time = 0, value = 0.5 },
    { time = 4, value = 1.0 },
    { time = 8, value = 0.3 },
})
openstudio.setAutomationMode(trackId, "volume", "read")
openstudio.clearAutomation(trackId, "volume")
```

**Audio Analysis:**
```lua
local stats = openstudio.measureLUFS("C:/audio/mix.wav")
openstudio.print("Integrated: " .. stats.integrated .. " LUFS")
openstudio.print("True Peak: " .. stats.truePeak .. " dBTP")

local transients = openstudio.detectTransients("C:/audio/drums.wav", 0.3)
openstudio.print("Found " .. #transients .. " transients")

local silences = openstudio.detectSilentRegions("C:/audio/take.wav", -50, 0.5)
```

**Track Freeze:**
```lua
openstudio.freezeTrack(trackId)                -- Freeze (render FX offline)
openstudio.unfreezeTrack(trackId)              -- Unfreeze (restore)
```

**Rendering:**
```lua
openstudio.renderProject("C:/output/mix.wav", "wav", 24, 44100, 0, 60)
```

**Utility:**
```lua
openstudio.print("Hello from OpenStudio!")      -- Console output
local ver = openstudio.getAppVersion()          -- Get version string
openstudio.showMessage("Alert", "Processing complete!")  -- Dialog
local file = openstudio.fileDialog("Open Audio", "*.wav;*.aiff")  -- File picker
```

For the complete API reference, see [API.md](API.md).

### 14.4 Example Scripts

**Set up a recording template:**
```lua
-- Create tracks for a band recording
local drums = openstudio.addTrack("Drums OH")
local bass = openstudio.addTrack("Bass DI")
local guitar = openstudio.addTrack("Guitar")
local vocal = openstudio.addTrack("Vocal")

-- Set levels
openstudio.setTrackVolume(drums, -3.0)
openstudio.setTrackVolume(bass, -6.0)
openstudio.setTrackVolume(guitar, -6.0)
openstudio.setTrackVolume(vocal, 0.0)

-- Pan instruments
openstudio.setTrackPan(guitar, -0.3)

-- Add EQ to all tracks
for _, id in ipairs({ drums, bass, guitar, vocal }) do
    openstudio.addTrackJSFX(id, "OpenStudio EQ")
end

openstudio.setTempo(120)
openstudio.print("Band template ready!")
```

**Analyze and report loudness for all audio files:**
```lua
local files = { "C:/audio/verse.wav", "C:/audio/chorus.wav", "C:/audio/bridge.wav" }
for _, file in ipairs(files) do
    local stats = openstudio.measureLUFS(file)
    openstudio.print(file .. ": " .. stats.integrated .. " LUFS, peak " .. stats.truePeak .. " dBTP")
end
```

---

## 15. Customization

### 15.1 Themes

OpenStudio includes several built-in themes:

| Theme           | Description                            |
|-----------------|----------------------------------------|
| **Dark**        | Default dark theme (dark grays/blues)  |
| **Light**       | Light theme for bright environments    |
| **Midnight**    | Deep dark blue theme                   |
| **High Contrast** | Maximum contrast for accessibility  |

Change theme via **Options > Theme** or the Command Palette.

### 15.2 Theme Editor

For custom theming, open **View > Theme Editor...**. The Theme Editor allows you to customize individual color tokens and create your own theme presets.

### 15.3 Keyboard Shortcuts

Open **Help > Keyboard, Mouse & Trackpad** to browse the searchable action reference,
print a cheat sheet for the current platform, choose input profiles, and rebind
supported actions.

Press `F1` for the **Help Reference**, which is separate from the Keyboard, Mouse & Trackpad window.

Use **Help > Getting Started Guide** for the built-in first-session walkthrough covering navigation gestures, essential hotkeys, track creation, recording, and export.

Keyboard and **Mouse & scroll** profiles are selected independently. The 19
built-in profile families are OpenStudio, Pro Tools, Cubase/Nuendo, REAPER,
Audacity, Logic Pro, FL Studio, Ableton Live, Studio One, Bitwig Studio,
Reason, Cakewalk/Sonar, GarageBand, Digital Performer, Ardour, Adobe Audition,
Mixcraft, Waveform, and Renoise.

Create named custom keyboard profiles to add multiple bindings, set separate
macOS/Windows/Linux/fallback overrides, intentionally unassign an action,
inherit its base mapping again, and import/export the profile as JSON. Conflict
checks run before an overlapping key is accepted.

Bindings can be scoped to global, Timeline/ruler, track controls, Mixer, Piano
Roll, Pitch Editor, automation, browser, plug-in, modal, and contextual
surfaces. Custom shortcut editing lives in the Keyboard, Mouse & Trackpad window, not
in Preferences. See [Keyboard, Hotkey, Mouse, and Scroll
Profiles](input-profiles.md) for the full behavior and safety rules.

### 15.4 Preferences

Open **Options > Preferences** (`Ctrl+,`) to access the full preferences dialog:

**General tab:**
- Snap to Grid enable/disable
- Default grid size (Bar, 1/2 Bar, 1/4 Bar, 1/8 Bar, Beat, Half Beat, Quarter Beat, Second, Minute)
- Project defaults

**Editing tab:**
- Auto-Crossfade enable/disable
- Default crossfade length (in milliseconds)
- Record mode (Normal / Overdub / Replace)
- Ripple editing mode (Off / Per Track / All Tracks)

**Display tab:**
- Timecode mode (Time / Beats / SMPTE)
- SMPTE frame rate (24, 25, 29.97, 30 fps)
- UI Font Scale (75% to 150%, for accessibility)
- Panel visibility settings

In the development checkout, toolbar and transport groups wrap when larger fonts
need more room. Track controls scroll inside their lane when they exceed its
height; the track name remains at the top. This change still requires release
packaging before it is available in downloaded installers.

**Mouse tab:**
- Choose the active **Mouse & scroll profile** independently from the keyboard map.
- Configure what happens when you click with different modifier keys in various contexts:
  - Clip Drag, Clip Resize, Timeline Click, Track Header, Automation Point, Fade Handle, Ruler Click
  - Each context exposes all 16 combinations of semantic Primary, Secondary, Alt/Option, and Shift
- **Clear Custom Overrides** removes the persisted fine-grained overrides and returns to the selected base profile.
- The selected mouse/scroll base profile and validated per-gesture overrides persist and are shared with detached windows.

**Backup tab:**
- Enable/disable auto-backup
- Backup interval (1-60 minutes)

### 15.5 Grid Size

The grid determines snap positions and visual gridlines. Available sizes:

| Grid Size      | Description                          |
|----------------|--------------------------------------|
| Bar            | Full bar (e.g., 4 beats in 4/4)     |
| 1/2 Bar        | Half a bar                          |
| 1/4 Bar        | Quarter bar                         |
| 1/8 Bar        | Eighth bar                          |
| Beat           | Single beat                          |
| Half Beat      | Half a beat                          |
| Quarter Beat   | Quarter beat (16th note in 4/4)     |
| Second         | One second                           |
| Minute         | One minute                           |

Set the grid size via **View > Grid Size** submenu or the Preferences dialog.

### 15.6 Screensets

Screensets save and recall window layouts:

| Action            | Shortcut           |
|-------------------|--------------------|
| Save Screenset 1  | `Ctrl+Shift+1`     |
| Save Screenset 2  | `Ctrl+Shift+2`     |
| Save Screenset 3  | `Ctrl+Shift+3`     |
| Load Screenset 1  | `Ctrl+1`           |
| Load Screenset 2  | `Ctrl+2`           |
| Load Screenset 3  | `Ctrl+3`           |

Screensets save which panels are visible and their layout, allowing quick switching between editing, mixing, and mastering views.

### 15.7 Toolbar Customization

Open **View > Toolbar Editor...** to customize the Main Toolbar:

- Add or remove buttons.
- Rearrange button order.
- Create custom toolbars.
- Toggle toolbar visibility via **View > Toolbars**.

### 15.8 Command Palette

Press `Ctrl+Shift+P` to open the Command Palette. Type to fuzzy-search through all available actions. Press Enter to execute the selected action. This lets you access actions without memorizing their shortcut or menu location.

### 15.9 Plugin Bridge (32-bit)

If you have 32-bit VST plugins that need to run in the 64-bit OpenStudio environment:

- Toggle via **Options > Toggle 32-bit Plugin Bridge**.
- This control is currently experimental. OpenStudio's stable plugin hosting path is 64-bit native plugin hosting.

---

## 16. Keyboard Shortcuts

The tables below show the **OpenStudio default keyboard profile**. Other
built-in profiles, platform-specific bindings, custom overrides, and active
editor scopes can change or intentionally unassign these keys. Use **Help >
Keyboard, Mouse & Trackpad** for the effective map.

In these keyboard tables, `Ctrl` becomes `Cmd` on macOS. The legacy keyboard
`Alt` token becomes physical `Ctrl` on macOS: for example, Render is
`Ctrl+Alt+R` on Windows/Linux and `Cmd+Ctrl+R` on macOS. Mouse `Alt/Option`
gestures use physical Option on macOS. The shortcut window prints the effective
platform keys without this portable notation.

### 16.1 Transport

| Action                | Shortcut                |
|-----------------------|-------------------------|
| Play / Stop           | `Space`                 |
| Stop                  | No separate default    |
| Record                | `Ctrl+R`                |
| Go to Start           | `Home`                  |
| Toggle Loop           | `L`                     |
| Toggle Metronome Enable | `K`                   |
| Start / Stop Click-Only Metronome | `Ctrl+Shift+Space` (macOS: `Cmd+Shift+Space`) |
| Set Loop to Selection | `Ctrl+L`                |
| Tap Tempo             | `T`                     |

### 16.2 File

| Action                | Shortcut          |
|-----------------------|-------------------|
| New Project           | `Ctrl+N`          |
| Open Project          | `Ctrl+O`          |
| Open (Safe Mode)      | `Ctrl+Shift+O`    |
| Save Project          | `Ctrl+S`          |
| Save As               | `Ctrl+Shift+S`    |
| Close Project         | `Ctrl+F4`         |
| Render / Export       | `Ctrl+Alt+R`      |
| Project Settings      | `Alt+Enter`       |
| Quit                  | `Ctrl+Q`          |

### 16.3 Edit

| Action                     | Shortcut          |
|----------------------------|--------------------|
| Undo                       | `Ctrl+Z`           |
| Redo                       | `Ctrl+Shift+Z`     |
| Cut                        | `Ctrl+X`           |
| Copy                       | `Ctrl+C`           |
| Paste                      | `Ctrl+V`           |
| Delete Selected            | `Delete`            |
| Select All Tracks          | `Ctrl+A`           |
| Select All Clips           | `Ctrl+Shift+A`     |
| Deselect All               | `Esc`              |
| Split at Cursor            | `S`                |
| Group Selected Clips       | `Ctrl+G`           |
| Ungroup Selected Clips     | `Ctrl+Shift+G`     |
| Toggle Clip Mute           | `U`                |
| Nudge Left                 | `Left`             |
| Nudge Right                | `Right`            |
| Nudge Left (Fine)          | `Ctrl+Left`        |
| Nudge Right (Fine)         | `Ctrl+Right`       |

### 16.4 Tools

| Tool          | Shortcut |
|---------------|----------|
| Select Tool   | `V`      |
| Split Tool    | `B`      |
| Mute Tool     | `X`      |
| Smart Tool    | `Y`      |

### 16.5 Insert

| Action                     | Shortcut           |
|----------------------------|---------------------|
| New Audio Track            | `Ctrl+T`            |
| New MIDI Track             | `Ctrl+Shift+T`      |
| Quick Add Instrument Track | `Ctrl+Shift+I`      |
| Import Media File          | `Insert`            |
| Add Marker                 | `M`                 |
| Add Named Marker           | `Shift+M`           |
| Add Region from Selection  | `Shift+R`           |

### 16.6 View

| Action                          | Shortcut             |
|---------------------------------|----------------------|
| Toggle Mixer                    | `Ctrl+M`             |
| Toggle Virtual MIDI Keyboard    | `Alt+B`              |
| Toggle Undo History             | `Ctrl+Alt+Z`         |
| Clip Properties                 | `F2`                 |
| Help Reference                  | `F1`                 |
| Keyboard, Mouse & Trackpad      | Help menu            |
| Zoom to Time Selection          | `Ctrl+Shift+E`       |
| Zoom In                         | `Ctrl++`             |
| Zoom Out                        | `Ctrl+-`             |
| Zoom to Fit                     | `Ctrl+0`             |
| Save Screenset 1                | `Ctrl+Shift+1`       |
| Save Screenset 2                | `Ctrl+Shift+2`       |
| Save Screenset 3                | `Ctrl+Shift+3`       |
| Load Screenset 1                | `Ctrl+1`             |
| Load Screenset 2                | `Ctrl+2`             |
| Load Screenset 3                | `Ctrl+3`             |
| Command Palette                 | `Ctrl+Shift+P`       |

### 16.7 Navigation

| Action              | Shortcut     |
|---------------------|--------------|
| Next Transient      | `Tab`        |
| Previous Transient  | `Shift+Tab`  |

### 16.8 Options

| Action          | Shortcut  |
|-----------------|-----------|
| Preferences     | `Ctrl+,`  |
| Tap Tempo       | `T`       |

### 16.9 MIDI

| Action                     | Shortcut |
|----------------------------|----------|
| Quantize Notes Using Last Settings | `Q` |
| Transpose +1 Semitone      | (via menu/command palette) |
| Transpose -1 Semitone      | (via menu/command palette) |
| Transpose Octave Up (+12)  | (via menu/command palette) |
| Transpose Octave Down (-12)| (via menu/command palette) |
| Velocity +10%              | (via menu/command palette) |
| Velocity -10%              | (via menu/command palette) |
| Reverse MIDI Notes         | (via menu/command palette) |
| Invert MIDI Note Pitches   | (via menu/command palette) |
| Select All Notes           | `Ctrl+A` |

### 16.10 Mouse Shortcuts (OpenStudio Profile)

`Primary` means Ctrl on Windows/Linux and Command on macOS.

| Surface / action | OpenStudio mouse gesture |
|---|---|
| Vertical workspace scroll | Scroll |
| Timeline zoom | Primary+Scroll |
| Horizontal timeline scroll | Shift+Scroll |
| Resize track height | Alt/Option+Scroll |
| Zoom waveform height | Primary+Shift+Scroll |
| Move / copy clip | Drag / Primary+Drag |
| Slip-edit clip contents | Primary+Shift+Drag |
| Axis-lock clip move | Shift+Drag; locks to the first axis that crosses the threshold |
| Move clip without snap | Alt/Option+Drag |
| Resize / fine resize clip edge | Drag / Primary+Drag edge |
| Symmetric resize / stretch clip | Shift+Drag / Alt/Option+Drag edge |
| Seek on empty timeline | Click |
| Select range / extend selection | Primary+Click-drag / Shift+Click-drag |
| Create a razor edit | Alt/Option+Drag empty timeline |
| Select / toggle / range-select track | Click / Primary+Click / Shift+Click track header |
| Solo track | Alt/Option+Click track header |
| Move / fine-move automation point | Drag / Primary+Drag |
| Constrain automation point vertically / delete | Shift+Drag / Alt/Option+Click point |
| Adjust / fine-adjust fade handle | Drag / Primary+Drag |
| Symmetric fade / cycle fade shape | Shift+Drag / Alt/Option+Click handle |
| Seek from ruler | Click ruler |
| Set loop / time selection / zoom range | Primary+Drag / Shift+Drag / Alt/Option+Drag ruler |
| Context menu | Right-click |

---

## 17. Troubleshooting

### 17.1 No Audio Output

**Symptoms**: Playback shows "Playing" but no sound is heard.

**Solutions**:
1. Check **Audio Settings** (View > Audio Settings...) and verify the correct output device is selected.
2. Make sure your audio interface is powered on and connected.
3. Check that tracks are not muted and the master volume is up.
4. Verify no tracks are soloed that should not be (solo mutes all other tracks).
5. If using ASIO, ensure no other application is using the ASIO driver exclusively.

### 17.2 High Latency

**Symptoms**: Noticeable delay between playing and hearing sound.

**Solutions**:
1. Switch to **ASIO** drivers (lowest latency).
2. Reduce the **Buffer Size** in Audio Settings. Try 128 or 256 samples.
3. Close other audio applications that may be competing for the audio device.
4. If you hear crackling, increase the buffer size slightly until stable.

### 17.3 Audio Crackling or Glitches

**Symptoms**: Pops, clicks, or crackling during playback or recording.

**Solutions**:
1. Increase the **Buffer Size** in Audio Settings (try 512 or 1024 samples).
2. Freeze CPU-heavy tracks (right-click > Freeze Track).
3. Reduce the number of active plugins.
4. Close unnecessary background applications.
5. Check your audio interface drivers are up to date.

### 17.4 Plugin Not Showing Up

**Symptoms**: A VST3 plugin you installed is not appearing in the plugin list.

**Solutions**:
1. Ensure the plugin is installed in a standard VST3 directory.
2. Open the FX Chain Panel and click **Scan** to rescan for plugins.
3. Verify the plugin is a supported 64-bit plugin. VST3 is the most mature path; CLAP/LV2 compatibility may vary by plugin and build.
4. Check that the plugin file is not corrupted.

### 17.5 Plugin Causing Crashes or Noise

**Symptoms**: A specific plugin causes OpenStudio to crash, hang, or produce unexpected noise.

**Solutions**:
1. Open the project in **Safe Mode** (`Ctrl+Shift+O`) to bypass all plugins on load.
2. Selectively enable plugins one at a time to identify the problematic one.
3. Some plugins require specific channel configurations. Check the plugin's documentation.
4. Update the plugin to its latest version.
5. Remove the plugin and re-add it to reset its state.

### 17.6 Missing Media Files

**Symptoms**: Project loads but some clips show as empty or display a missing file warning.

**Solutions**:
1. When prompted, use the Missing Media dialog to browse for the moved files.
2. If files were moved, point to their new location.
3. Use the Missing Media dialog to resolve each referenced path; the full Media
   Pool panel is not mounted in the current workspace.
4. If original files are lost, re-record or re-import the audio.

### 17.7 Recording Issues

**Symptoms**: Record button is disabled, or recording produces empty clips.

**Solutions**:
1. Ensure at least one track is **armed for recording** (Record Arm button is active).
2. Check that the correct **Input Device** is selected in Audio Settings.
3. Verify the input channel assignment on the armed track's Track Header.
4. Confirm audio signal is reaching the track (check the activity meter on the Track Header).
5. Check **Record Safe** is not enabled on the track (prevents recording).

#### macOS microphone permission recovery

macOS uses the **Microphone** privacy permission for every audio input,
including built-in microphones and USB/Thunderbolt audio interfaces. A device
can appear in Audio Settings while its captured samples remain silent if access
was denied.

1. Quit OpenStudio.
2. Open **System Settings > Privacy & Security > Microphone** and enable
   OpenStudio.
3. Reopen OpenStudio, select the input device again, arm a track, and verify the
   input meter.

If OpenStudio is missing from that list or the stored decision appears stuck,
you can optionally reset permission for only the installed OpenStudio bundle:

```bash
bundle_id="$(defaults read /Applications/OpenStudio.app/Contents/Info CFBundleIdentifier)"
tccutil reset Microphone "$bundle_id"
```

If the app is installed elsewhere, adjust the path in the first command. Then
relaunch OpenStudio and choose **Allow** when macOS asks. Avoid the broader
`tccutil reset Microphone` command unless you intentionally want to reset
microphone permission for every application.

### 17.8 Project Won't Save

**Symptoms**: Save fails or project file appears empty.

**Solutions**:
1. Verify the target directory is writable.
2. Try **Save As** to a different location.
3. Check available disk space.
4. Ensure no antivirus software is blocking write access.

### 17.9 MIDI Controller Not Recognized

**Symptoms**: MIDI device does not appear in the input selector.

**Solutions**:
1. Ensure the MIDI controller is connected and powered on before launching OpenStudio.
2. Check that the MIDI driver is installed (if required by the device).
3. Restart OpenStudio after connecting the device.
4. Verify the device appears in Windows Device Manager under Sound, video, and game controllers.

### 17.10 Waveform Not Displaying

**Symptoms**: Audio clips appear as empty blocks without waveform visualization.

**Solutions**:
1. This may occur on first load as the peak cache is being built. Wait a moment.
2. OpenStudio uses `.ospeaks` sidecar files for waveform display. Legacy `.ospeaks` files are still supported and will be regenerated automatically if needed.
3. Ensure the referenced audio file exists and is readable.
4. Try zooming in or out to trigger a waveform refresh.

### 17.11 Render Produces Silence

**Symptoms**: Rendered file is silent or contains only silence.

**Solutions**:
1. Verify the render time range covers the section where clips exist. Check the Start and End times in the Render dialog.
2. Ensure the Source is set correctly (Master mix for full mix, specific tracks for stems).
3. Check that tracks are not muted and clips are not muted.
4. Verify the project plays back correctly before rendering.
5. Try rendering with "Entire project" bounds to confirm the issue.

### 17.12 High CPU Usage

**Symptoms**: CPU usage is consistently high, causing performance issues.

**Solutions**:
1. **Freeze tracks** with heavy plugins (right-click > Freeze Track).
2. Increase the audio buffer size.
3. Remove or bypass plugins you are not actively using.
4. Reduce the number of simultaneous tracks.
5. Close the Mixer Panel, Spectrum Analyzer, and Loudness Meter when not needed (they use CPU for real-time display).

### 17.13 Keyboard Shortcuts Not Working

**Symptoms**: Keyboard shortcuts do not trigger their expected actions.

**Solutions**:
1. Ensure the main OpenStudio window has focus (click on the timeline or a panel).
2. If a text input field is focused (e.g., renaming a track), keyboard shortcuts are temporarily disabled. Press `Esc` to defocus.
3. Open **Help > Keyboard, Mouse & Trackpad**. `F1` opens the separate Help Reference,
   not the active key map.
4. Confirm the selected keyboard profile, the current platform override, and
   whether the action is intentionally unassigned.
5. Check the action's scope. Timeline, Piano Roll, Pitch Editor, Mixer,
   automation, browser, plug-in, track-control, and modal bindings run only in
   their matching context.
6. If a custom profile is active, choose **Inherit** for one target or reset the
   profile to compare against its built-in base map.

---

## 18. AI Music and Assisted Audio

OpenStudio includes AI-assisted workflows that live inside the normal DAW session. The small Basic Pitch model is bundled, with audio-to-MIDI inference enabled in current ONNX-enabled Windows/Linux releases. Generation and stem workflows use optional AI Tools runtimes and large model assets installed on demand.

### 18.1 AI Tools Setup

Use **AI Tools Setup** when a generation or stem workflow reports that its runtime is missing.

- The installer prepares optional local runtime assets instead of making the base DAW download huge.
- Installation can be cancelled, reset, or retried from the setup modal.
- On Windows, a CUDA-to-DirectML fallback prepares a separate runtime and selects it only after validation; an unsuccessful fallback leaves the runtime selection and downloaded models unchanged.
- The downloadable managed macOS AI runtime requires Apple Silicon and macOS 14 or later because of its bundled numerical-library wheels. The base app targets macOS 12 or later; the managed AI archive is not qualified for macOS 12/13.
- Generated audio is imported back into the project as normal clips/tracks.

**Downloading models:** BS-Roformer and ACE-Step download automatically when you install their feature. For Stable Audio 3 Medium or MiniMax Music 3, select the model, review and accept its license, then choose **Download and Set Up**. OpenStudio downloads the required files from Hugging Face into managed storage. Stable Audio is converted automatically to Diffusers format; MiniMax downloads its Diffusers components without the duplicate legacy weights. Allow extra disk space and time for downloads and Stable Audio conversion.

**Model versions (development checkout):** Select a model, then choose **Original** or **INT8** in **Model version**. The suggestion above the selector explains when INT8 may help. AI Tools Setup lists both versions under each model, with separate installed status. Choose INT8 and **Download and Prepare INT8** to install it; select that same version in the generation dialog. The choice is saved with the AI track, supports undo/redo, and is retained when changing workflows within the same model.

INT8 currently requires an NVIDIA CUDA GPU. ACE-Step and Stable Audio quantize the diffusion transformer; MiniMax quantizes its language model, including the output projection. Other audio components keep their normal inference precision. Setup reuses installed original weights when possible, otherwise downloads the official original weights and prepares a separate serialized INT8 copy once. **The initial download is not smaller.** An already prepared OpenStudio INT8 folder can also be imported. Original and INT8 installations coexist; generation stays offline and does not silently fall back to Original if INT8 fails.

INT8 reduces weight memory, but can change audio quality and is not always faster. MiniMax can still take minutes per song on a 16 GB GPU. Its INT8 path uses a temporary, bounded disk cache for inactive stages (about 15 GiB), avoiding a full additional RAM copy; each active stage runs on the GPU. Allow extra free disk space and a longer first load. Other GPUs and CPU-only systems should use Original; selecting INT8 is not a promise that MiniMax fits every small GPU. See [local quantization test evidence](ai-quantization-2026-09-16.md) for actual machine results and limitations.

Stable Audio requires access approval on its Hugging Face model page, including acceptance of the Stability AI and Gemma terms. Enter a read token from the approved account in setup, or leave it blank to use an existing Hugging Face login or `HF_TOKEN`. The token entered in the app is used only for that setup and is not saved. The app's license checkbox does not grant access to a gated repository. MiniMax's public download does not require a token.

**Setup progress:** the panel above the model list stays visible while you scroll or select another tool. It shows the active model, current step and elapsed time. Hugging Face model setup checks the full download size first, then shows **Downloaded**, **Remaining**, **Download size**, and the percentage. Downloaded bytes include completed cache files, with the reused amount shown separately. Dependency installation, conversion and validation show an active indicator when no byte total is available. Use **Show details** or **Open Install Log** for diagnostics. Closing the panel lets setup continue; keep OpenStudio running and reopen it with the **AI** button. **Cancel Setup** stops the job.

**Import Local Model** remains available for existing downloads. A failed or cancelled setup leaves the previous installed model in place. Retrying a download reuses completed Hugging Face cache files. Generation uses the installed model locally; it does not upload your audio to Hugging Face.

**Stem model download recovery (development checkout):** setup retries empty
checkpoint or configuration files and rejects empty or truncated downloads.
Healthy cached files remain available. If the install log reports a directory
where a model file should be, move that directory out of the reported model path
and retry setup; OpenStudio preserves it instead of deleting it automatically.
These checks establish file/download completeness, not model quality or a
checksum guarantee for every existing cache file.


**Linux qualification status (2026-10-01 development checkout):** installed
Basic Pitch conversion passes on Ubuntu 22.04, 24.04 and 26.04 in the local
candidate. Setup navigation and download-time reporting have also been corrected.
The separate Linux CPU runtime 0.0.14 is published with Python 3.11.15; the app
fixes remain unpublished. Native ACE-Step generation/import/undo/redo passes on
the Ubuntu 26.04 Radeon 8060S host using ROCm and shared GPU memory. This does not
qualify NVIDIA INT8, every model, other GPU/OS combinations or subjective quality.
See [the dated Ubuntu AI report](ai-ubuntu-qualification-2026-10-01.md).

**Integrated PR 26 qualification (2026-10-07):** fresh CPU runtime/stem-model
setup, real download cancellation/retry, six-stem inference and native ROCm
generation/import/undo/redo passed on the recorded Linux candidates. Native
seven-track save/open/resave also passed. See the
[integration report](linux-pr26-qualification.md) for exact artifacts, source,
remaining platform/model checks and the limits of these results. This remains
an unpublished application candidate.

### 18.2 AI Tracks

AI tracks are used for prompt-driven generation workflows:

| Workflow | Description |
|----------|-------------|
| **Text to Music** | Generates a fresh music clip using ACE-Step from style/arrangement prompt, optional lyrics, BPM, duration, time signature, language, key/scale, seed, and generation controls. |
| **Lyrics + Style** | Uses ACE-Step or MiniMax Music 3 with lyrics and a musical prompt. |
| **Song Sections** | Uses MiniMax Music 3 with separate verse, chorus, bridge, vocal-direction, and arrangement fields. |
| **Text to Audio** | Generates audio from a prompt using Stable Audio 3 Medium when that runtime/model is installed. |

Create an AI track from the Insert menu, the command palette, or the `Ctrl+Alt+T` shortcut if it is still bound to its default.

### 18.3 Clip AI Workflows

Right-click an audio clip and open **AI Generation** for source-conditioned
workflows using ACE-Step or Stable Audio 3. MiniMax Music 3 does not offer these
clip workflows.

| Workflow | Description |
|----------|-------------|
| **Create Variation** | Generates a related version of the selected clip while preserving source identity according to the source/variation controls. |
| **Inpaint Selection** | Regenerates the time selection that overlaps the clip while matching the surrounding audio. Create a time selection first. |
| **Continue Clip** | Generates a continuation tail from the selected clip using the prompt and tail-length/source controls. |

### 18.4 Stem Separation

Stem separation splits a source clip into component tracks for remixing, cleanup, practice, or arrangement work:

- Vocals
- Drums
- Bass
- Guitar
- Piano
- Other

The resulting stems are imported back into the session as editable clips.

### 18.5 Audio to MIDI

The audio-to-MIDI workflow uses Basic Pitch / ONNX plumbing where available to extract MIDI note data from audio. Use it when you want to turn a recorded or imported performance into MIDI material for editing, layering, or replacement.

**Development correction:** Basic Pitch uses fixed inference windows and named
model outputs. Invalid input or inference failures report an error; no-note
results do not create empty MIDI tracks. Installed conversion, undo/redo and
saved MIDI reopening pass for the synthetic test on Ubuntu 22.04/24.04/26.04.
These changes are not yet in a public application release. Transcription accuracy
on arbitrary music still needs musical evaluation.

### 18.6 Model Controls, Progress, and Memory

Choose the model before the workflow; available workflows and controls depend
on that model. ACE-Step has dedicated musical and diffusion controls. MiniMax
uses a music description and tagged lyrics or **Song Sections**, a seed, and
diffusion steps per chunk. Its **Maximum length (seconds)** caps generation;
the song can finish earlier, and longer requests need more time and memory.
Stable Audio 3 Medium exposes a sound description, duration, seed, and steps;
the current distilled workflow uses fixed guidance rather than editable CFG,
negative-prompt, or LoRA controls.

Generation shows the current stage and elapsed time. Sampling progress uses
reported denoising steps or MiniMax audio frames; loading, preparation, and
decoding can remain indeterminate. A stage percentage is not an estimate of
the entire job's remaining time. Closing and reopening a generation panel
preserves its active job while the app remains running; use cancellation to
stop a request.

The current checkout's **Hardware check** estimates available memory for the
request. Refresh after closing other applications; an unavailable or favorable
estimate does not guarantee success. The worker makes the final decision.
Supported workers adapt model placement/offloading to memory availability and
release idle model caches after about two minutes. Offloading can trade speed
for memory and does not make every model practical on every GPU or CPU.
These mechanisms do not establish audio quality or hardware qualification.

---

## Appendix A: Project File Location

OpenStudio project files (`.osproj`) are saved to the location you choose when saving. Recorded audio files are stored in a subdirectory alongside the project file.

## Appendix B: Audio Format Support

**Import formats**: WAV, AIFF, FLAC, MP3, OGG Vorbis, MIDI, and video audio extraction where FFmpeg is available. The audited executable is bundled on Windows; FFmpeg-backed operations require a system `ffmpeg` on `PATH` on macOS/Linux.

**Export formats**: WAV, AIFF, FLAC, MP3, OGG Vorbis, MIDI, and DDP export. MP3/OGG and other FFmpeg conversions require the bundled Windows executable or a system `ffmpeg` on macOS/Linux.

**Plugin formats**: VST3 is the stable primary path. CLAP and LV2 code paths are present where available. Experimental 32-bit bridging controls are not part of the stable plugin-hosting path.

## Appendix C: Supported Audio Interfaces

OpenStudio supports any audio interface that provides:
- ASIO drivers (recommended for professional use)
- WASAPI drivers (built into Windows)
- DirectSound drivers (legacy support)

ASIO is strongly recommended for recording and low-latency monitoring.

---

## Appendix D: Signal Flow

Understanding OpenStudio's signal flow helps with troubleshooting and advanced mixing:

```text
Audio Input (Device Channel)
    |
    v
[Input FX Chain]  -- Applied pre-fader
    |
    v
[Track Volume Fader]  -- Controlled by automation in Read mode
    |
    v
[Track Pan]  -- Equal-power panning (cos/sin law)
    |
    v
[Track FX Chain]  -- Insert effects applied post-fader
    |                \
    v                 \---> [Send] ---> Bus Track ---> [Bus FX] ---> Master
    |
    v
[Track Output]
    |
    v
[Master Bus]
    |
    v
[Master FX Chain]
    |
    v
[Master Volume & Pan]
    |
    v
Audio Output (Device)
```

Key points:
- Input FX are applied before the track fader, so they are not affected by fader automation.
- Track FX are applied after the fader.
- Sends can be pre-fader (level independent of track fader) or post-fader (follows the fader).
- Automation can control volume, pan, and plugin parameters at any point in the chain.
- The master bus receives the sum of all track outputs and send bus outputs.

## Appendix E: File Formats and Technical Specifications

### Peak Cache Files (.ospeaks)

OpenStudio generates `.ospeaks` sidecar files alongside audio files for efficient waveform display:

- These files cache multi-resolution peak data at 4 mipmap levels (64, 256, 1024, 4096 samples per peak).
- They are automatically generated on first load and regenerated if the source audio changes.
- Deleting `.ospeaks` files is safe; they will be regenerated automatically.
- Peak cache files are typically much smaller than their source audio files.

### Sample Rate Handling

- OpenStudio handles sample rate conversion automatically when importing audio files recorded at different rates than the project's device rate.
- Linear interpolation is used for real-time sample rate conversion during playback.
- Offline rendering supports the selected target sample rate. The **Resample Quality** selector is currently a UI placeholder and does not yet change the backend conversion algorithm.

### Audio Thread Safety

OpenStudio uses the following audio-thread safety patterns:
- Non-blocking locks on the audio thread (try-lock pattern) reduce the risk of callback stalls.
- Pre-allocated audio buffers avoid heap allocations during audio processing.
- Pre-loaded audio file readers prevent disk I/O on the audio thread.
- Atomic operations for parameter updates (volume, pan) avoid mutex contention.

## Appendix F: Tips and Best Practices

### Recording

1. Always set your buffer size before recording. Lower buffers reduce monitoring latency but increase CPU load.
2. Record at the native sample rate of your audio interface for best quality.
3. Leave headroom when setting input levels. Aim for peaks around -12 to -6 dB.
4. Use auto-backup to protect against data loss during long recording sessions.

### Mixing

1. Start mixing with all faders at unity (0 dB) and bring down the loudest elements first.
2. Use bus tracks for grouping related instruments (drums, guitars, vocals).
3. Save mixer snapshots before making major changes so you can compare.
4. Use the Loudness Meter to ensure your mix targets the correct loudness standard (e.g., -14 LUFS for streaming).

### Performance

1. Freeze tracks with heavy plugins when you are done editing them.
2. Close panels you are not using (Spectrum Analyzer, Loudness Meter, Phase Correlation).
3. Use ASIO drivers for the best audio performance.
4. If your project has many tracks, consider increasing the buffer size to 512 or 1024 samples.

### Organization

1. Name tracks descriptively as you add them. Renaming later is easy, but naming from the start saves time.
2. Use track colors to visually group related instruments.
3. Use folder tracks to organize large sessions (e.g., a "Drums" folder containing kick, snare, toms, overheads).
4. Add markers at song sections (intro, verse, chorus) for quick navigation.
5. Use regions to define render boundaries for individual sections.

### Scripting

1. Use Lua scripts to automate repetitive tasks (e.g., adding the same FX chain to every vocal track).
2. The `openstudio.print()` function is useful for debugging scripts.
3. Scripts can access all track, transport, FX, and automation functions.
4. Save commonly used scripts as files for reuse across projects.

---

## Appendix G: Glossary

| Term                | Definition                                                                |
|---------------------|---------------------------------------------------------------------------|
| **ASIO**            | Audio Stream Input/Output. A low-latency audio driver protocol.          |
| **Automation**      | Time-varying parameter changes recorded or drawn on the timeline.         |
| **Buffer Size**     | Number of audio samples processed per callback. Lower = less latency.    |
| **Bus**             | A track that receives audio from sends, used for submixing or FX returns.|
| **CC**              | MIDI Continuous Controller. Messages for parameters like mod wheel, sustain. |
| **Clip**            | A block of audio or MIDI data placed on the timeline.                     |
| **Comping**         | Assembling the best parts from multiple recording takes.                  |
| **Crossfade**       | A smooth transition between two overlapping clips.                        |
| **DAW**             | Digital Audio Workstation. Software for recording, editing, and mixing.   |
| **dB (Decibel)**    | Unit of measurement for audio level.                                      |
| **dBFS**            | Decibels relative to full scale. 0 dBFS is the maximum digital level.    |
| **Dither**          | Low-level noise added when reducing bit depth to mask quantization.       |
| **Fade In/Out**     | Gradual volume increase at clip start / decrease at clip end.             |
| **Fader**           | Volume control slider in the mixer.                                       |
| **Freeze**          | Render a track's FX chain to audio to save CPU.                          |
| **Grid**            | Visual and snap alignment points on the timeline.                         |
| **Input Monitoring**| Hearing the live input signal through the track's processing chain.       |
| **Latency**         | Delay between input and output, primarily determined by buffer size.      |
| **Loop**            | Repeating playback of a specific time range.                              |
| **LUFS**            | Loudness Units Full Scale. Standardized loudness measurement.             |
| **MIDI**            | Musical Instrument Digital Interface. Protocol for note/control data.     |
| **Normalize**       | Adjusting audio level so the peak reaches a target (usually 0 dBFS).     |
| **Nudge**           | Moving a clip by a small, precise amount.                                |
| **Offline Render**  | Bouncing/exporting audio faster than real-time.                          |
| **Pan**             | Stereo positioning of a signal between left and right.                    |
| **Peak Cache**      | Pre-computed waveform data stored in `.ospeaks` files.                    |
| **Playhead**        | The vertical line indicating the current position in time.                |
| **Punch In/Out**    | Recording only within a specific time range.                              |
| **Quantize**        | Aligning MIDI notes or clips to the grid.                                |
| **Razor Edit**      | Selecting a time range on specific tracks for precise editing.            |
| **Region**          | A named time range on the timeline.                                       |
| **Render**          | Exporting the project (or portions) to an audio file.                     |
| **Ripple Edit**     | Automatic shifting of subsequent clips when content is inserted/removed.  |
| **Sample Rate**     | Number of audio samples per second (e.g., 44100 Hz, 48000 Hz).          |
| **Screenset**       | A saved window layout configuration.                                      |
| **Send**            | A signal routing from a track to a bus, used for effects returns.        |
| **Slip Edit**       | Moving audio content within a clip without moving the clip itself.        |
| **SMPTE**           | Society of Motion Picture and Television Engineers. Timecode format.      |
| **Snap**            | Automatic alignment of clips and edits to grid positions.                |
| **Solo**            | Isolating one or more tracks by muting all others.                        |
| **Stem**            | An individual track or group of tracks rendered as a separate file.       |
| **Take**            | One recording pass. Multiple takes can be stored and comped.              |
| **TCP**             | Track Control Panel. The area showing track headers on the left.         |
| **Tempo Map**       | A series of tempo changes over time (variable BPM).                      |
| **Transient**       | A sharp, short-lived peak in an audio signal (e.g., drum hit).           |
| **VCA**             | Voltage Controlled Amplifier. A fader that controls linked track volumes.|
| **VST3**            | Virtual Studio Technology 3. A plugin format for audio effects and instruments. |
| **WASAPI**          | Windows Audio Session API. Windows built-in audio driver system.          |

---

*OpenStudio -- User Manual*
*For the latest documentation and updates, refer to the project repository.*

## In-app updates

This section describes the current implementation. The signed-download and
macOS/Linux automatic-replacement changes are not in the published v0.1.01
application. Existing users need a release containing the new updater first;
see [migration and qualification](updater-security-and-migration.md).

### Microsoft Store installations

Store MSIX installations retain the in-app check, download, progress, cancellation
and save-before-install interface. Package identity selects Microsoft's Store
APIs; they never launch the direct EXE updater. Each new version must be submitted
to Partner Center. Microsoft may request confirmation and close the app during
installation. OpenStudio's automatic-check preference does not change Windows'
own Store automatic-update settings. See [Store qualification](release-runbook.md#microsoft-store-distribution)
for the implementation, tests and outstanding Store-flight upgrade check.

### Direct-download installations

Debug development builds do not check for, download, or launch release installers.
The update panel identifies the running development version and explains that the
checkout must be rebuilt. A separately installed app does not change the version
of a running development executable.

Release builds offer an update only when its numeric version is strictly newer
than the running application. Leading zeroes are equivalent (`0.1.01` equals
`0.1.1`); stale same/older offers are rejected again before download and install.

Release builds check for updates shortly after startup and periodically while the app is
open, skipping scheduled checks during playback or recording. Successful checks
are normally limited to once per 24 hours. An available update appears in a
non-blocking banner. **Help > Check for Updates** opens the update panel and
checks immediately. The panel also lets users disable automatic checks.

Users choose when to download and install. Downloads run in the background with
progress and cancellation. The updater verifies Ed25519-signed release metadata,
checks architecture and minimum OS/glibc requirements, and requires HTTPS, the
declared size, and a matching SHA-256 checksum. It verifies the staged package
again before installation. Invalid downloads are rejected. Manifest signatures
authenticate the update offer; they do not replace platform code signing or
notarization.

Before installation, playback and recording must stop. Modified projects must
save successfully; cancelling the save postpones installation. If the project
changes while saving or preparing the installer, installation is also postponed.
Cancelling normal app shutdown cancels the pending replacement.

| Platform | Final installation step |
| --- | --- |
| Windows | Opens the installer and requests normal app shutdown. Follow the installer and reopen OpenStudio. The installer is explicitly prevented from force-closing the app. |
| macOS | **Install update & restart** prepares the verified DMG, replaces an eligible user-owned app bundle after shutdown, and relaunches through macOS. Protected/root-owned installations require manual replacement. |
| Linux | **Install update & restart** replaces an eligible user-owned type-2 AppImage after shutdown and relaunches it. Package-manager or protected installations require their normal manual update path. |

Downloads are staged under the user's OpenStudio application-data `updates`
directory. A completed staged download and its signed offer persist across
restart. The app checks them again before restoring **ready to install**, even
when automatic network checks are off. A partial download is not a ready update.
The automatic-check preference is saved in the embedded browser's local storage.

### macOS/Linux safeguards and recovery

The helper prepares the replacement before closing the app, verifies the package
and installed application again, and requires normal save-aware shutdown and
exclusive access to the installation. It refuses unsafe links/permissions,
insufficient disk space, unsupported filesystems, root execution, and concurrent
installers. Use a trusted user-owned location, such as `~/Applications` on macOS;
do not change system-directory permissions to force an update.

The previous application is retained beside the installation in a private
`.OpenStudio-update-<transaction-id>` directory. The restarted app must confirm
that its main interface is ready. An early exit triggers verified rollback and
relaunch of the previous version. If the process stays alive but confirmation
does not arrive within two minutes, both versions are retained; the helper
does not kill a potentially active session. Interrupted transactions retain
recovery information and do not trigger a blind rollback on the next launch.
The update panel reports transaction status, package and backup paths. Retained
files consume disk space; remove them manually only after confirming the new
version works and no recovery is needed. Project files are not replaced by the
installer.

**Unsigned macOS builds:** relaunch uses normal macOS security checks. The updater
does not remove quarantine or bypass Gatekeeper. An unsigned update may require
approval through macOS before it can open; unattended success is not guaranteed.
Use the manual package path if replacement is refused. Native helper fixtures
have passed on Linux and both Mac architectures, but real downloaded packages,
Gatekeeper, AppImage/FUSE, and old-to-new project upgrades still require release
qualification.

**Upgrading from v0.1.01:** metadata corrections cannot change the installed
updater code. For the first macOS upgrade, quit the old app and install the new
DMG manually. For Linux, make the downloaded AppImage executable (file manager
permissions or `chmod +x` on that exact file), quit the old app, replace it, and
launch the new one. Preserve projects and user settings. Subsequent releases
can use the new flow once it is included in the installed application.

## File formats and upgrade compatibility

Current projects use `.osproj`; rack preset exports use `.ospreset`, themes use
`.ostheme`, and waveform caches use `.ospeaks`. Scripted effects use standard
`.jsfx` files and the Lua application API uses `openstudio.*`.

Older product identifiers and file formats are unsupported by the current loader.
Renaming a file or folder does not convert its serialized processor state. Back up
projects, recordings and presets before updating; retain the older application if
you still need to open unconverted sessions. A maintainer's one-time conversion of
individual NAM presets does not establish automatic project/preset migration for
other installations. Model and cabinet IR files must remain available separately.
Waveform caches can be regenerated from the original audio.


## Development workflows (September 29, 2026)

These working-tree additions follow app commit `52cbd7c`; they are not a released
or fully platform-qualified feature set.

- **Active audio status:** at the right of the File/Edit menu row, `48 kHz · 16 spl` reports the
  running device's accepted rate and buffer. Pending dialog edits do not alter
  this display. Click it to open Audio Settings. A stopped/missing device shows
  Audio unavailable.
- **USB/webcam microphones:** on Windows select WASAPI and its Input Device;
  on macOS select the microphone through CoreAudio and grant microphone access.
  Select the matching mono input on an audio track, arm it, then record. An
  Audient ASIO driver exposes Audient inputs, not an unrelated USB microphone.
  Combining an unrelated WASAPI input with an ASIO output is not supported by a
  single selected backend. macOS device aggregation is configured in Audio MIDI
  Setup. Test the actual input/output pair; enumeration is not a recording test.
- **Timed practice:** expand **Practice timer** in Metronome Settings and choose Countdown (seconds) or
  Stopwatch, then Start timer. The timer uses project BPM, supports Pause/Resume
  and Reset, and remains visible in the transport when the dialog closes. A
  countdown stops the practice click when time expires. Play/Record interrupts
  timed practice; the timer never stops a recording. Device loss also interrupts
  it. Timing is driven by processed audio samples, not browser timers.
- **Metronome sounds:** expand **Click sounds** to select Electronic (original),
  Woodblock, 808-style cowbell or Mechanical tick independently for Regular and
  Accent. Use **Choose file...** for a custom WAV, AIFF, FLAC or Ogg; selecting
  Electronic (original) restores the original tone. The first 2 seconds of a
  custom file are inspected; the strongest channel's sharp attack is aligned,
  peak-matched and faded to at most 100 ms. Unusable samples are rejected while
  keeping the previous choice. Prepared copies are stored locally and converted
  to the active device rate; include these files when transferring projects.
  Highlighted beat buttons use the accent sound; beat 1 is always accented.
- **Menus:** dropdowns and submenus are capped at 80% of the viewport height
  and scroll internally. Windows app-owned native title bars use a consistent
  dark appearance; operating-system high-contrast colours remain available.
- **Solo Safe:** right-click a track's Solo button, use the track context menu,
  or the Toggle Solo Safe on Selected Tracks action. The slashed Solo indicator
  marks safety. A safe track remains eligible to play when other tracks are
  soloed; it does not activate solo by itself, and explicit Mute still wins.
  It is saved with the project and supports Undo/Redo. For a bus/return to stay
  audible, enable Solo Safe on that bus/return too; this does not unmute upstream
  source tracks. Master render follows these flags; isolated stems retain their
  existing isolation policy.
- **Native windows:** main, mixer, detached MIDI, graphical pitch and built-in plugin editors use
  OS title bars and normal move/resize/minimize/maximize controls. Startup layout
  refreshes do not change their outer bounds. Detached windows retain the monitor
  containing their saved bounds, constrained to its work area.
- **Detached pitch editing:** choose **Detach** in the graphical pitch editor.
  **Focus** brings its native window forward; **Dock** returns it to the main
  window. Closing the native window hides the editor and retains committed edits
  for reopening the same clip. Notes, selection, analysis, history and pitch zoom
  survive docking. Pitch zoom/scroll are independent of the arrangement. Each
  committed gesture shares the project's Undo/Redo; unfinished drags are cancelled
  when the view loses focus or closes. Only one graphical pitch session is open
  at a time. Changing the source clip invalidates its edit session.
- **Interrupted pitch view:** a detached view that stops responding returns to
  the main editor. Loss of the main session's heartbeat stops transient audition
  and retains accepted notes in a local recovery checkpoint. After reopening the
  matching saved project/source clip and completing analysis, **Recover pitch
  edits from interrupted session** restores those notes as an undoable edit.
  Recovery checks the original file's size/modification time and clip region;
  it does not recreate unsaved projects or the old process's entire undo history.
- **Microphone interruption:** if the audio device stops during a take, the
  app stops recording and finalizes the available audio. Check the input device
  and channel selection before starting a new take; recording does not silently
  continue through a replacement device.

Platform and hardware qualification is recorded in the
[detached pitch and desktop qualification notes](testing.md#desktop-and-recording-acceptance).
Injected Windows input and browser scaling tests do not establish macOS/Linux,

mixed-monitor DPI, sustained microphone capture or subjective audio quality.
