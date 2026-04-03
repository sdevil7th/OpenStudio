# OpenStudio User Manual

Version 3.0 -- Comprehensive Reference Guide

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

---

## 1. Getting Started

### 1.1 System Requirements

OpenStudio is a desktop DAW built with a JUCE C++ audio backend and a React/TypeScript frontend rendered through an embedded web UI.

**Minimum requirements:**

- Windows 10 or later (64-bit), or macOS for the desktop release
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

1. Download the latest Windows installer or macOS package from the official download page.
2. Run the installer and complete the setup steps for your platform.
3. Launch OpenStudio from the Start menu, Applications folder, or desktop shortcut.

**Windows:** run the installer and follow the wizard. If you are using the unsigned zero-cost release path, Windows SmartScreen may warn before first launch.

**macOS:** OpenStudio v1 ships as an unsigned DMG. Drag `OpenStudio.app` to `Applications`. If macOS blocks launch, right-click the app, choose **Open**, and if needed allow it under **System Settings > Privacy & Security**.

OpenStudio also includes automatic update support. You can trigger a manual update check from **Help > Check for Updates...**.

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
2. Select your preferred **Audio System** (ASIO recommended for lowest latency).
3. If using ASIO, select your **ASIO Driver** from the dropdown.
4. If using WASAPI or DirectSound, select your **Input Device** and **Output Device**.
5. Choose a **Sample Rate** (44100 Hz or 48000 Hz are standard).
6. Set a **Buffer Size** (lower values reduce latency but increase CPU load; 256 or 512 samples is a good starting point).
7. Click **Apply** to activate the settings.

### 1.4 Creating Your First Project

After configuring audio, you are ready to begin:

1. The application starts with a new, empty project.
2. Add your first track:
   - Press `Ctrl+T` to add an audio track, or
   - Press `Ctrl+Shift+T` to add a MIDI track.
3. Import audio:
   - Go to **Insert > Media file...** (or press `Insert`).
   - Browse and select an audio file (WAV, AIFF, FLAC, MP3, OGG).
   - The file will be placed at the playhead position on the selected track.
4. Press `Space` to play back.
5. Save your project with `Ctrl+S` (project files use the `.osproj` extension).

### 1.5 Project File Format

OpenStudio projects are saved as `.osproj` files. Legacy `.s13` projects continue to load. These contain:

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
| **Help**  | Getting Started Guide, Help Reference, Keyboard Shortcuts, updates, About |

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
- **Time selection**: A highlighted region created by clicking and dragging on the ruler or timeline background.
- **Razor edits**: Semi-transparent selection areas created with Alt+drag for precise non-destructive editing.

**Essential Navigation:**
- **Scroll**: native vertical scrolling through the workspace.
- **Ctrl+Scroll**: horizontal timeline zoom around the mouse pointer.
- **Shift+Scroll**: horizontal timeline scroll.
- **Alt+Scroll**: track height resize.
- **Ctrl+Shift+Scroll**: track-height zoom style adjustment for faster resizing.
- **First-session hotkeys**: `Space`, `Ctrl+R`, `Ctrl+T`, `Ctrl+M`, `S`, `B`, `Delete`, `Ctrl+S`, `F1`, `Ctrl+Shift+P`.
- **Need a refresher?** Press `F1` for the searchable **Help Reference** and open **Help > Keyboard Shortcuts** for the full shortcut list and custom global rebinding.

**Zoom and Scroll:**
- **Horizontal zoom**: `Ctrl+Scroll wheel` (or `Ctrl+Plus` / `Ctrl+Minus`). Zoom range: 1 to 1000 pixels per second.
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
- **Play** (green triangle): Starts playback. `Space`
- **Stop** (square): Stops playback/recording. `Space` (while playing)
- **Pause** (parallel bars): Pauses playback.
- **Loop** (repeat icon): Toggles loop playback mode. `L`
- **Metronome** (metronome icon): Toggles the click track.

**Right Section - Project Info:**
- **Time Signature** input: Click to change numerator/denominator (e.g., 4/4, 3/4, 6/8).
- **Metronome Settings** (gear icon): Opens metronome configuration (sound, accent pattern, volume).
- **BPM** input: Type a new tempo value (range: 10-300 BPM). Press Enter or click away to apply.
- **TAP** button: Tap repeatedly to set tempo by feel. Also available via `T` key.

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
| Media Explorer           | View menu               | Browse and preview media files                  |
| Media Pool               | View menu               | All media files used in the current project     |
| Loudness Meter           | View > Metering         | LUFS loudness measurement                       |
| Spectrum Analyzer        | View > Metering         | Frequency spectrum display                      |
| Phase Correlation Meter  | View > Metering         | Stereo phase correlation                        |
| Video Window             | View menu               | Video playback for scoring to picture           |
| Script Editor            | View menu               | Lua scripting environment                       |
| Toolbar Editor           | View menu               | Customize toolbar layout                        |
| Command Palette          | `Ctrl+Shift+P`          | Fuzzy search for any action in the application  |
| Help Reference           | `F1`                    | Searchable in-app reference for controls and features |
| Keyboard Shortcuts       | Help menu               | Searchable shortcut reference and custom global rebinding |

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

Track reordering can also be done via Lua scripting using `s13.reorderTrack(fromIndex, toIndex)`.

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

1. Right-click a track > "Freeze Track" or use `s13.freezeTrack(trackId)` in Lua.
2. The track's FX chain is rendered offline and the frozen audio replaces live processing.
3. The frozen indicator appears on the track.
4. To restore: right-click > "Unfreeze Track" or `s13.unfreezeTrack(trackId)`.

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
- Available devices can be queried via Lua: `s13.getMIDIDevices()`.

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
- `Ctrl+Click` to add/remove clips from the selection.
- `Shift+Click` for range selection.
- Click empty timeline background to deselect all clips.
- `Ctrl+Shift+A` to select all clips.
- `Esc` to deselect all.

**Track selection:**
- Click a track header to select it.
- `Ctrl+Click` for multi-select.
- `Shift+Click` for range select.
- `Ctrl+A` to select all tracks.

**Time selection:**
- Click and drag on the timeline ruler to create a time selection.
- The time selection is highlighted as a shaded region.
- Time selections are used for punch recording, rendering bounds, and editing operations.

### 6.2 Moving Clips

- Click and drag a clip to move it to a new position or track.
- When snap is enabled, the clip snaps to grid lines.
- Hold `Ctrl` while dragging to copy the clip instead of moving it.
- Hold `Shift` while dragging to constrain movement to horizontal only (time axis).
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

1. Hold `Ctrl+Shift` and drag within a clip.
2. The clip's boundaries stay fixed, but the audio content slides earlier or later within the clip.
3. This is useful for adjusting the timing of audio relative to the clip boundaries.

### 6.6 Fade In/Fade Out

Each clip has adjustable fade-in and fade-out regions:

1. Hover over the top-left corner of a clip to see the fade-in handle.
2. Hover over the top-right corner to see the fade-out handle.
3. Drag the handle inward to create or extend the fade.
4. The fade is displayed as a curved line on the clip.

**Auto-Crossfade**: When enabled (toggle in Main Toolbar or View menu), overlapping clips on the same track automatically create crossfades.

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

1. Hold `Alt` and drag on the timeline to create a razor selection area.
2. The razor area appears as a semi-transparent highlight.
3. Press `Delete` or use **Edit > Delete Razor Edit Content** to remove the content within the razor areas.
4. Use **Edit > Clear Razor Edits** to dismiss the razor selection without deleting.

Razor edits respect ripple mode settings.

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
2. Press `Q` or go to **MIDI > Quantize Notes...**
3. The quantize dialog allows setting the quantize grid, strength, and whether to quantize note ends.

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

Toggle the Drum Editor mode via **View > Toggle Drum Editor**. The drum editor provides a grid-based view optimized for drum programming, where each row represents a drum instrument rather than a pitch.

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
- Drag the fader or use the track header volume knob.
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

OpenStudio includes a set of built-in effects identified by the `OpenStudio` prefix in current releases. Legacy `S13` effect names are still accepted for compatibility in older projects and scripts.

| Effect           | Description                                    |
|------------------|------------------------------------------------|
| **OpenStudio EQ**         | Parametric equalizer with graphical display |
| **OpenStudio Compressor** | Dynamic range compressor with graph         |
| **OpenStudio Gate**       | Noise gate with threshold visualization     |
| **OpenStudio Delay**      | Tempo-synced delay effect with graph        |
| **OpenStudio Reverb**     | Algorithmic reverb with visualization       |
| **OpenStudio Saturator**  | Harmonic saturation/distortion              |
| **OpenStudio Chorus**     | Chorus modulation effect                    |

Each built-in OpenStudio effect includes:
- Dedicated parameter sliders
- Visual graph showing the effect curve or response
- Preset management (save/load presets)
- Bypass toggle

### 9.4 VST3 Plugin Support

OpenStudio hosts third-party VST3 plugins for both effects and virtual instruments:

**Scanning for plugins:**
1. Go to the FX Chain Panel or Plugin Browser.
2. Click **Scan** to scan standard VST3 directories for installed plugins.
3. Scanned plugins appear in the plugin list organized by manufacturer and category.

**Adding a VST3 plugin:**
1. Open the FX Chain Panel for a track.
2. Click the **+** button or "Add Plugin".
3. Browse the plugin list (filterable by name, manufacturer, category).
4. Click a plugin to add it to the chain.
5. The plugin's native editor window opens automatically.

**Plugin editor windows:**
- VST3 editors open in separate native windows.
- Parameters can be adjusted in the native editor or via the FX Chain Panel's parameter list.

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

Drag and drop effects within the FX Chain Panel to change their order. The signal flows from top to bottom through the chain.

### 9.9 Safe Mode (Bypass FX on Load)

If a project with heavy or problematic plugins is slow to load, open it in Safe Mode:

- **File > Open Project (Safe Mode)...** (`Ctrl+Shift+O`)
- All FX plugins are bypassed on load, allowing the project to open quickly.
- You can then selectively enable plugins as needed.

---

## 10. Automation

### 10.1 Automation Overview

Automation allows parameter values to change over time. OpenStudio supports automation for:

- Track volume
- Track pan
- Track mute
- Plugin parameters (per-parameter automation)

### 10.2 Showing Automation Lanes

1. Click the automation disclosure triangle on a track header, or right-click and select "Show Automation".
2. Automation lanes appear below the track in the timeline.
3. Select which parameter to display from the lane dropdown.

### 10.3 Drawing Automation

1. Show the automation lane for the desired parameter.
2. Click on the automation lane to add a point.
3. Click and drag to draw multiple points.
4. Drag existing points to adjust their position and value.
5. Delete points by selecting them and pressing Delete.

Automation points are displayed as connected lines on the lane, with the area between filled to show the value visually.

### 10.4 Automation Modes

Each automation lane has a mode that determines how automation interacts with playback and recording:

| Mode      | Description                                                                  |
|-----------|------------------------------------------------------------------------------|
| **Read**  | Automation plays back. Manual parameter changes are temporary.               |
| **Write** | During playback, all parameter changes are recorded as new automation data, overwriting existing points. |
| **Touch** | Records automation only while the user is actively touching a control. Reverts to existing automation on release. |
| **Latch** | Like Touch, but after release, continues writing the last value until transport stops. |

Set the automation mode via the lane dropdown or `s13.setAutomationMode()` in Lua.

### 10.5 Automation and Clip Movement

The **Move Envelopes with Items** option (Options menu) determines whether automation points move when their associated clips are moved:

- **Enabled**: Automation points follow clip movement.
- **Disabled**: Automation points stay in their original time positions.

### 10.6 Automation Value Ranges

| Parameter | Frontend Range | Backend Range          |
|-----------|---------------|------------------------|
| Volume    | 0.0 - 1.0    | -60 dB to +6 dB       |
| Pan       | 0.0 - 1.0    | -1.0 (L) to +1.0 (R)  |
| Mute      | 0.0 / 1.0    | Off / On               |

The frontend stores normalized values (0-1) which are converted to native units when sent to the backend.

### 10.7 Clearing Automation

- Delete individual points by selecting and pressing Delete.
- Clear all automation for a parameter: right-click the lane > "Clear Automation".
- Via Lua: `s13.clearAutomation(trackId, parameterId)`.

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

### 12.2 Render Source

Choose what to render:

| Source                      | Description                                           |
|-----------------------------|-------------------------------------------------------|
| **Master mix**              | Full stereo mix of all tracks through the master bus   |
| **Selected tracks (stems)** | Individual stems for each selected track               |
| **Master mix + all stems**  | Master mix plus individual stems for every track       |
| **Selected media items**    | Only the selected clips, direct output                 |
| **Selected items via master** | Selected clips routed through the master FX chain    |
| **Razor edit areas**        | Render each razor edit area as a separate file         |

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

| Format          | Description                          | Bit Depth Options          |
|-----------------|--------------------------------------|----------------------------|
| **WAV**         | Standard uncompressed audio          | 16-bit, 24-bit, 32-bit float |
| **AIFF**        | Apple uncompressed audio             | 16-bit, 24-bit, 32-bit float |
| **FLAC**        | Lossless compressed audio            | 16-bit, 24-bit             |
| **MP3**         | Lossy compressed (128-320 kbps)      | N/A (bitrate-based)        |
| **OGG Vorbis**  | Lossy compressed (quality 3-10)      | N/A (quality-based)        |
| **RAW PCM**     | Headerless PCM data                  | 16-bit, 24-bit, 32-bit float |

**Sample rate**: 44100, 48000, 88200, 96000, or 192000 Hz.
**Note**: The actual render always processes at the current device sample rate.

**Channels**: Stereo or Mono.

### 12.6 Processing Options

| Option          | Description                                                      |
|-----------------|------------------------------------------------------------------|
| **Normalize**   | Peak-normalizes the output to 0 dBFS                             |
| **Dither**      | Applies dither when reducing bit depth. Types: TPDF, Noise Shaped. Only available for 16-bit and 24-bit output. |
| **Resample Quality** | Fast, Good, or Best quality for sample rate conversion      |

### 12.7 Secondary Output

Enable **Secondary output** to simultaneously render a second format (e.g., render WAV master + MP3 reference):

1. Check "Secondary output".
2. Select the secondary format (MP3, OGG, FLAC, WAV, AIFF).
3. Select the secondary bit depth.

### 12.8 Metadata

Expand the **Metadata** section to embed information in the rendered file:

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
| **Online render (1x speed)**  | Render in real-time instead of offline (for live capture or plugin compatibility) |
| **Add to project after render** | Automatically import rendered files as new clips in the project |

### 12.10 Render Queue

Instead of rendering immediately, click **Add to Queue** to add the render job to the Render Queue. Open the Render Queue via **View > Render Queue** to manage and batch-process multiple render jobs.

### 12.11 Region Render Matrix

For complex multi-region, multi-format rendering, use **File > Region Render Matrix...**. This provides a grid interface to configure which regions render in which formats.

### 12.12 DDP Export

For CD mastering, use **File > DDP Disc Image Export...** to create a DDP (Disc Description Protocol) disc image suitable for CD replication.

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

The Media Pool (**View > Media Pool** or **File > Media Pool**) lists all audio and MIDI files used in the current project:

- View file paths, durations, sample rates, and channel counts.
- Identify missing media files.
- Remove unused media references.

### 13.9 Missing Media Resolver

When a project references audio files that cannot be found at their stored paths:

1. OpenStudio displays a warning on project load.
2. The Missing Media dialog allows you to browse for moved files or point to new locations.
3. Resolved paths are saved with the project.

### 13.10 Auto-Save / Auto-Backup

Configure automatic backups via **Options > Preferences > Backup**:

| Setting             | Description                                          |
|---------------------|------------------------------------------------------|
| Enable Auto-Backup  | Toggle automatic backup on/off                       |
| Backup Interval     | Time between backups (1-60 minutes, default 5 min)   |

Auto-backup saves the project at regular intervals when changes are detected. It requires the project to have been saved at least once (has a file path).

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

Record OpenStudio's master output in real-time:

- Go to **File > Capture Output** to toggle live capture.
- Audio is recorded to a file as it plays.
- Useful for capturing improvisations or live performances.

---

## 14. Scripting

### 14.1 Overview

OpenStudio includes a Lua scripting engine that provides programmatic access to nearly all DAW functions. Scripts can automate repetitive tasks, create custom workflows, and extend OpenStudio's capabilities.

### 14.2 Script Editor

Open the Script Editor via **View > Script Editor**:

- Write Lua scripts in the editor pane.
- Click **Run** to execute the script.
- Output appears in the console pane below.
- Use `s13.print(...)` to output messages to the console.

### 14.3 Scripting API Overview

All scripting functions are currently accessed through the legacy `s13.*` namespace. Key categories include:

**Track Operations:**
```lua
local id = s13.addTrack("Vocals")        -- Create a new track
s13.setTrackVolume(id, -6.0)             -- Set volume in dB
s13.setTrackPan(id, -0.5)               -- Pan left 50%
s13.setTrackMute(id, true)              -- Mute the track
s13.setTrackSolo(id, true)              -- Solo the track
s13.setTrackArm(id, true)               -- Arm for recording
s13.removeTrack(id)                      -- Delete a track
s13.reorderTrack(0, 3)                  -- Move track from index 0 to index 3
```

**Transport Control:**
```lua
s13.play()                               -- Start playback
s13.stop()                               -- Stop
s13.record()                             -- Start recording
s13.setPlayhead(10.5)                    -- Jump to 10.5 seconds
s13.setTempo(120)                        -- Set BPM
s13.setTimeSignature(3, 4)              -- Set 3/4 time
s13.setLoop(true, 4, 12)               -- Enable loop from 4s to 12s
```

**FX Chain:**
```lua
s13.addTrackFX(trackId, pluginId)        -- Add VST3 plugin
s13.addTrackS13FX(trackId, "OpenStudio EQ") -- Add built-in effect
s13.removeTrackFX(trackId, 0)           -- Remove first FX
s13.bypassTrackFX(trackId, 0, true)     -- Bypass first FX
local fx = s13.getAvailableS13FX()       -- List built-in effects
```

**Master Bus:**
```lua
s13.setMasterVolume(1.0)                -- Set master volume (linear)
s13.setMasterPan(0.0)                   -- Set master pan (center)
```

**Sends:**
```lua
local idx = s13.addTrackSend(trackId, busId)  -- Add send
s13.setTrackSendLevel(trackId, idx, 0.7)      -- Set send level
s13.removeTrackSend(trackId, idx)              -- Remove send
```

**Automation:**
```lua
s13.setAutomationPoints(trackId, "volume", {
    { time = 0, value = 0.5 },
    { time = 4, value = 1.0 },
    { time = 8, value = 0.3 },
})
s13.setAutomationMode(trackId, "volume", "read")
s13.clearAutomation(trackId, "volume")
```

**Audio Analysis:**
```lua
local stats = s13.measureLUFS("C:/audio/mix.wav")
s13.print("Integrated: " .. stats.integrated .. " LUFS")
s13.print("True Peak: " .. stats.truePeak .. " dBTP")

local transients = s13.detectTransients("C:/audio/drums.wav", 0.3)
s13.print("Found " .. #transients .. " transients")

local silences = s13.detectSilentRegions("C:/audio/take.wav", -50, 0.5)
```

**Track Freeze:**
```lua
s13.freezeTrack(trackId)                -- Freeze (render FX offline)
s13.unfreezeTrack(trackId)              -- Unfreeze (restore)
```

**Rendering:**
```lua
s13.renderProject("C:/output/mix.wav", "wav", 24, 44100, 0, 60)
```

**Utility:**
```lua
s13.print("Hello from OpenStudio!")      -- Console output
local ver = s13.getAppVersion()          -- Get version string
s13.showMessage("Alert", "Processing complete!")  -- Dialog
local file = s13.fileDialog("Open Audio", "*.wav;*.aiff")  -- File picker
```

For the complete API reference, see [API.md](API.md).

### 14.4 Example Scripts

**Set up a recording template:**
```lua
-- Create tracks for a band recording
local drums = s13.addTrack("Drums OH")
local bass = s13.addTrack("Bass DI")
local guitar = s13.addTrack("Guitar")
local vocal = s13.addTrack("Vocal")

-- Set levels
s13.setTrackVolume(drums, -3.0)
s13.setTrackVolume(bass, -6.0)
s13.setTrackVolume(guitar, -6.0)
s13.setTrackVolume(vocal, 0.0)

-- Pan instruments
s13.setTrackPan(guitar, -0.3)

-- Add EQ to all tracks
for _, id in ipairs({ drums, bass, guitar, vocal }) do
    s13.addTrackS13FX(id, "OpenStudio EQ")
end

s13.setTempo(120)
s13.print("Band template ready!")
```

**Analyze and report loudness for all audio files:**
```lua
local files = { "C:/audio/verse.wav", "C:/audio/chorus.wav", "C:/audio/bridge.wav" }
for _, file in ipairs(files) do
    local stats = s13.measureLUFS(file)
    s13.print(file .. ": " .. stats.integrated .. " LUFS, peak " .. stats.truePeak .. " dBTP")
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

Open the **Keyboard Shortcuts** window from the **Help** menu to browse the searchable shortcut reference, print a cheat sheet, and rebind supported shortcuts.

Press `F1` for the **Help Reference**, which is separate from the Keyboard Shortcuts window.

Use **Help > Getting Started Guide** for the built-in first-session walkthrough covering navigation gestures, essential hotkeys, track creation, recording, and export.

Custom shortcut rebinding currently lives in the **Keyboard Shortcuts** window, not in Preferences.

Custom rebinding currently applies to **global shortcuts**. Timeline- and editor-scoped shortcuts are documented in the reference but are not rebindable in this pass.

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

**Mouse tab:**
- Configure what happens when you click with different modifier keys in various contexts:
  - Clip Drag, Clip Resize, Timeline Click, Track Header, Automation Point, Fade Handle, Ruler Click
  - Each context can have different actions for: Click, Ctrl+Click, Shift+Click, Alt+Click
- Reset to defaults button

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

Press `Ctrl+Shift+P` to open the Command Palette. Type to fuzzy-search through all available actions. Press Enter to execute the selected action. This is the fastest way to access any feature without memorizing its shortcut or menu location.

### 15.9 Plugin Bridge (32-bit)

If you have 32-bit VST plugins that need to run in the 64-bit OpenStudio environment:

- Toggle via **Options > Toggle 32-bit Plugin Bridge**.
- This enables a bridging mechanism to load 32-bit plugins.

---

## 16. Keyboard Shortcuts

### 16.1 Transport

| Action                | Shortcut                |
|-----------------------|-------------------------|
| Play / Pause          | `Space`                 |
| Stop                  | `Space` (while playing) |
| Record                | `Ctrl+R`                |
| Go to Start           | Transport button / command palette |
| Toggle Loop           | `L`                     |
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
| Keyboard Shortcuts              | Help menu            |
| Zoom to Time Selection          | `Ctrl+Shift+E`       |
| Zoom In                         | `Ctrl+Plus`          |
| Zoom Out                        | `Ctrl+Minus`         |
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
| Quantize Notes             | Quantize dialog / command palette |
| Transpose +1 Semitone      | (via menu/command palette) |
| Transpose -1 Semitone      | (via menu/command palette) |
| Transpose Octave Up (+12)  | (via menu/command palette) |
| Transpose Octave Down (-12)| (via menu/command palette) |
| Velocity +10%              | (via menu/command palette) |
| Velocity -10%              | (via menu/command palette) |
| Reverse MIDI Notes         | (via menu/command palette) |
| Invert MIDI Note Pitches   | (via menu/command palette) |
| Select All Notes           | (via menu/command palette) |

### 16.10 Mouse Shortcuts

| Action                    | Mouse Gesture                          |
|---------------------------|----------------------------------------|
| Vertical navigate         | Scroll                                 |
| Timeline zoom             | Ctrl+Scroll                            |
| Horizontal navigate       | Shift+Scroll                           |
| Resize track height       | Alt+Scroll                             |
| Faster track-height zoom  | Ctrl+Shift+Scroll                      |
| Move clip                 | Drag clip                              |
| Copy clip                 | Ctrl+Drag clip                         |
| Constrain to horizontal   | Shift+Drag clip                        |
| Slip edit                 | Alt+Drag inside clip                   |
| Trim clip edge            | Drag left/right edge of clip           |
| Create fade               | Drag top-left or top-right corner      |
| Add gain point            | Shift+Click in clip                    |
| Rubber-band select clips  | Drag on empty timeline space           |
| Create razor edit         | Alt+Drag on timeline                   |
| Horizontal zoom           | Ctrl+Scroll wheel (on timeline)        |
| Horizontal scroll         | Shift+Scroll wheel                     |
| Move playhead             | Click on ruler                         |
| Create time selection     | Drag on ruler                          |
| Context menu              | Right-click                            |

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
3. Verify the plugin is a 64-bit VST3 (OpenStudio only supports 64-bit plugins natively; use the 32-bit bridge for older plugins).
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
3. Use **File > Media Pool** to view all referenced files and their status.
4. If original files are lost, re-record or re-import the audio.

### 17.7 Recording Issues

**Symptoms**: Record button is disabled, or recording produces empty clips.

**Solutions**:
1. Ensure at least one track is **armed for recording** (Record Arm button is active).
2. Check that the correct **Input Device** is selected in Audio Settings.
3. Verify the input channel assignment on the armed track's Track Header.
4. Confirm audio signal is reaching the track (check the activity meter on the Track Header).
5. Check **Record Safe** is not enabled on the track (prevents recording).

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
2. OpenStudio uses `.ospeaks` sidecar files for waveform display. Legacy `.s13peaks` files are still supported and will be regenerated automatically if needed.
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
3. Check the keyboard shortcuts reference (`F1`) to confirm the correct binding.
4. Open **Help > Keyboard Shortcuts** to confirm whether a global shortcut was customized or reset it to the default binding.
5. Some shortcuts are context-dependent (e.g., MIDI shortcuts only work when the Piano Roll is open).

---

## Appendix A: Project File Location

OpenStudio project files (`.osproj`) are saved to the location you choose when saving. Legacy `.s13` files are still supported. Recorded audio files are stored in a subdirectory alongside the project file.

## Appendix B: Audio Format Support

**Import formats**: WAV, AIFF, FLAC, MP3, OGG Vorbis

**Export formats**: WAV, AIFF, FLAC, MP3, OGG Vorbis, RAW PCM

**Plugin format**: VST3 (64-bit native, with optional 32-bit bridge)

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
- For rendering, the "Resample Quality" setting (Fast/Good/Best) controls the quality of the conversion algorithm.

### Audio Thread Safety

OpenStudio uses professional-grade audio thread safety patterns:
- Non-blocking locks on the audio thread (try-lock pattern) ensure glitch-free playback.
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
2. The `s13.print()` function is useful for debugging scripts.
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
