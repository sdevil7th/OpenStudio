/**
 * Contextual help texts for the Help Reference.
 * Entries are generated dynamically so displayed shortcuts stay in sync
 * with the user's current custom global shortcut overrides.
 */

import { getEffectiveActionShortcut } from "../store/actionRegistry";

export interface HelpEntry {
  title: string;
  description: string;
  shortcut?: string;
}

function shortcut(actionId: string, fallback: string): string {
  return getEffectiveActionShortcut(actionId) ?? fallback;
}

function buildHelpTexts(): Record<string, HelpEntry> {
  const playShortcut = shortcut("transport.play", "Space");
  const recordShortcut = shortcut("transport.record", "Ctrl+R");
  const loopShortcut = shortcut("transport.loop", "L");
  const newAudioTrackShortcut = shortcut("insert.audioTrack", "Ctrl+T");
  const newMidiTrackShortcut = shortcut("insert.midiTrack", "Ctrl+Shift+T");
  const newInstrumentTrackShortcut = shortcut("insert.quickAddInstrument", "Ctrl+Shift+I");
  const mixerShortcut = shortcut("view.toggleMixer", "Ctrl+M");
  const helpShortcut = shortcut("help.contextualHelp", "F1");
  const commandPaletteShortcut = shortcut("view.commandPalette", "Ctrl+Shift+P");
  const saveShortcut = shortcut("file.save", "Ctrl+S");
  const renderShortcut = shortcut("file.render", "Ctrl+Alt+R");
  const splitToolShortcut = shortcut("tools.splitTool", "B");
  const splitAtCursorShortcut = shortcut("edit.splitAtCursor", "S");
  const muteClipShortcut = shortcut("edit.muteClips", "U");
  const deleteShortcut = shortcut("edit.delete", "Delete");
  const keyboardShortcut = shortcut("view.keyboardShortcuts", "Help menu");
  const preferencesShortcut = shortcut("options.preferences", "Ctrl+,");
  const virtualKeyboardShortcut = shortcut("view.toggleVirtualKeyboard", "Alt+B");
  const clipPropertiesShortcut = shortcut("view.clipProperties", "F2");
  const commandPalettePath = `${commandPaletteShortcut}: Command Palette`;

  return {
    "navigation.essentials": {
      title: "Navigation & Essential Controls",
      description:
        "Normal mouse wheel uses native vertical scrolling in the workspace. Ctrl+Scroll zooms the timeline horizontally around the pointer. Shift+Scroll moves horizontally. Alt+Scroll changes track height. Ctrl+Shift+Scroll changes track height with a stronger zoom-style gesture. Start here if you are new to OpenStudio.",
      shortcut: `Scroll: Vertical | Ctrl+Scroll: Timeline Zoom | Shift+Scroll: Horizontal | Alt+Scroll: Track Height | ${playShortcut}: Play | ${recordShortcut}: Record | ${helpShortcut}: Help`,
    },
    "navigation.hotkeys": {
      title: "Core Hotkeys",
      description:
        "The fastest first-session keys are Play, Record, Add Track, Toggle Mixer, Split at Cursor, Split Tool, Delete, Save, Help Reference, and Command Palette. Custom rebinding applies to global shortcuts; timeline/editor-specific shortcuts remain reference-only for now.",
      shortcut: `${playShortcut} | ${recordShortcut} | ${newAudioTrackShortcut} | ${mixerShortcut} | ${splitAtCursorShortcut} | ${splitToolShortcut} | ${deleteShortcut} | ${saveShortcut} | ${commandPaletteShortcut}`,
    },
    "timeline": {
      title: "Timeline",
      description:
        "The main arrange view for audio and MIDI clips. Drag clips to move them, trim edges to edit timing, and use scroll gestures to navigate and zoom.",
      shortcut: `${splitToolShortcut}: Split Tool | ${splitAtCursorShortcut}: Split at Playhead | ${muteClipShortcut}: Mute Clip`,
    },
    "timeline.ruler": {
      title: "Time Ruler",
      description:
        "Click the ruler to move the playhead. Drag to create or adjust a project range, and Shift+click to extend an existing time selection.",
    },
    "timeline.clip": {
      title: "Audio & MIDI Clips",
      description:
        "Clips hold audio recordings or MIDI note data. Drag the body to move, drag the edges to trim, and use the top corners for fades when available.",
      shortcut: `${splitAtCursorShortcut}: Split | ${muteClipShortcut}: Toggle Mute | ${clipPropertiesShortcut}: Clip Properties | ${deleteShortcut}: Delete`,
    },
    "timeline.tools": {
      title: "Timeline Tools",
      description:
        "OpenStudio includes Select, Split, Mute, and Smart tools for editing. The Smart tool adapts between move, trim, and fade zones depending on pointer position.",
      shortcut: `${splitToolShortcut}: Split Tool | ${shortcut("tools.selectTool", "V")}: Select Tool | ${shortcut("tools.muteTool", "X")}: Mute Tool | ${shortcut("tools.smartTool", "Y")}: Smart Tool`,
    },
    "transport": {
      title: "Transport Bar",
      description:
        "Controls playback, recording, looping, metronome, and timeline position. The transport also exposes record-mode and ripple-mode status while working.",
      shortcut: `${playShortcut}: Play/Pause | ${recordShortcut}: Record | ${loopShortcut}: Loop`,
    },
    "transport.loopPunch": {
      title: "Loop, Punch & Metronome",
      description:
        "Use loop mode for repeated playback and punch-style recording workflows. The metronome and time-signature controls live alongside transport controls for quick setup.",
      shortcut: `${loopShortcut}: Loop | ${shortcut("options.tapTempo", "T")}: Tap Tempo`,
    },
    "tracks.types": {
      title: "Track Types",
      description:
        "OpenStudio supports audio, MIDI, instrument, and bus/group tracks. Choose the track type that matches whether you are recording sound, sequencing MIDI, hosting instruments, or routing a submix.",
      shortcut: `${newAudioTrackShortcut}: Audio | ${newMidiTrackShortcut}: MIDI | ${newInstrumentTrackShortcut}: Instrument`,
    },
    "tracks.recording": {
      title: "Recording Workflow",
      description:
        "Arm a track, choose the correct input, then record from the transport. Audio tracks capture audio clips, while MIDI and instrument tracks capture MIDI clips.",
      shortcut: `${recordShortcut}: Record`,
    },
    "tracks.inputs": {
      title: "Track Inputs & Monitoring",
      description:
        "Audio tracks use hardware input channels. MIDI and instrument tracks use MIDI device selection and monitoring so you can hear what you play while recording.",
    },
    "midi.instrument": {
      title: "MIDI & Instrument Workflow",
      description:
        "MIDI tracks sequence notes for devices or instruments. Instrument tracks combine MIDI recording with an instrument plugin so you can play and hear the result immediately.",
      shortcut: `${newMidiTrackShortcut}: MIDI Track | ${newInstrumentTrackShortcut}: Instrument Track | ${virtualKeyboardShortcut}: Virtual Keyboard`,
    },
    "midi.pianoroll": {
      title: "Piano Roll",
      description:
        "Use the Piano Roll to add, move, resize, and velocity-edit MIDI notes. This is the main editor for MIDI clips after recording or manual entry.",
    },
    "mixer": {
      title: "Mixer",
      description:
        "The mixer provides channel strips for tracks plus a dedicated master strip. Use it for level balancing, panning, mute/solo, FX access, and mixer snapshots.",
      shortcut: `${mixerShortcut}: Toggle Mixer`,
    },
    "mixer.master": {
      title: "Master Strip & Detached Mixer",
      description:
        "The master strip contains the final mix controls, metering, mono, FX, and automation access. The mixer can also be detached into its own native window for a dual-screen workflow.",
    },
    "mixer.snapshots": {
      title: "Mixer Snapshots",
      description:
        "Save and recall named mixer states to compare balances quickly. Snapshots are useful for trying alternate mix decisions without losing your current setup.",
    },
    "fx.chain": {
      title: "FX Chains",
      description:
        "Tracks can host input FX, track FX, and instrument plugins. Use FX chains for insert processing, ordering plugins, opening plugin editors, and bypassing processing.",
    },
    "fx.browser": {
      title: "Plugin Browser",
      description:
        "Use the Plugin Browser to scan, search, and insert plugins. Instrument-track creation and plugin loading flow through this browser.",
    },
    "fx.monitoring": {
      title: "Monitoring FX",
      description:
        "Monitoring FX live on the monitor path rather than in renders. Use them for headphone correction, monitor processing, or audition-only effects that should not print into exports.",
    },
    "automation": {
      title: "Automation",
      description:
        "Automation lets you write changes over time for volume, pan, mutes, and plugin parameters. Tracks and the master strip can expose automation lanes for detailed control.",
    },
    "pitch.editor": {
      title: "Pitch Editor & Pitch Correction",
      description:
        "Use the pitch tools for detailed correction, note editing, contour analysis, and advanced vocal tuning workflows directly inside the session.",
      shortcut: `${shortcut("edit.editPitch", "P")}: Open Pitch Editing`,
    },
    "stem.separation": {
      title: "Stem Separation",
      description:
        "Stem Separation can split a source clip into component stems for remixing, cleanup, practice, arrangement, or sound-design work. It is integrated into the broader edit and mix workflow.",
    },
    "routing": {
      title: "Routing & Buses",
      description:
        "Use sends, buses, track routing, and the Routing Matrix to build submixes, effect returns, and more complex signal flows.",
    },
    "routing.matrix": {
      title: "Routing Matrix",
      description:
        "The Routing Matrix gives you a visual overview of signal flow between tracks and buses so you can manage sends and destinations more quickly.",
    },
    "render.export": {
      title: "Render & Export",
      description:
        "Render the project to audio, export MIDI, archive a session, or prepare delivery formats such as DDP. Use Render when you are ready to create distributable output.",
      shortcut: `${renderShortcut}: Render / Export`,
    },
    "render.queue": {
      title: "Render Queue",
      description:
        "Use the Render Queue to manage pending or repeated exports without rerunning the same setup each time. It is useful for iterative delivery, stem passes, and overnight renders.",
    },
    "render.regionMatrix": {
      title: "Region Render Matrix",
      description:
        "The Region Render Matrix helps batch-render named regions and delivery combinations more efficiently than exporting each section by hand.",
    },
    "media.management": {
      title: "Media Explorer, Media Pool & Missing Media",
      description:
        "Browse source files, inspect project media, and resolve missing files from the dedicated media-management tools instead of hunting through the filesystem manually.",
    },
    "media.explorer": {
      title: "Media Explorer",
      description:
        "The Media Explorer is the audition-and-import browser for source files. Use it to preview material, navigate recent paths, and bring media into the session quickly.",
    },
    "media.pool": {
      title: "Media Pool",
      description:
        "The Media Pool tracks the media referenced by the current project so you can inspect usage, keep assets organized, and prepare cleanup or archive workflows.",
    },
    "media.batchConverter": {
      title: "Batch File Converter",
      description:
        "Use the Batch File Converter when you need to convert multiple source files outside the current timeline workflow, such as format normalization or delivery prep.",
    },
    "media.missing": {
      title: "Missing Media Resolver",
      description:
        "If files were moved or renamed, the Missing Media resolver helps reconnect project references instead of rebuilding clips manually.",
    },
    "project.management": {
      title: "Project Management",
      description:
        "OpenStudio includes templates, project compare, project tabs, backups, archive tools, and save/load actions to support larger real-world sessions.",
      shortcut: `${saveShortcut}: Save | ${shortcut("file.open", "Ctrl+O")}: Open | ${shortcut("file.new", "Ctrl+N")}: New`,
    },
    "project.templates": {
      title: "Project & Track Templates",
      description:
        "Templates help you start from repeatable routing, track layouts, and instrument setups instead of rebuilding the same session structure every time.",
    },
    "project.compare": {
      title: "Project Compare",
      description:
        "Project Compare lets you review the current state against the saved version so you can spot what changed before committing, saving, or rolling back decisions.",
    },
    "project.archive": {
      title: "Archive & Clean Project Tools",
      description:
        "Archive and cleanup tools help collect assets, trim unused project clutter, and prepare sessions for backup, handoff, or long-term storage.",
    },
    "markers.regions": {
      title: "Markers, Regions & Navigation",
      description:
        "Markers help you label points in the timeline, while regions define reusable sections for arrangement, looping, and targeted rendering. The Region/Marker Manager keeps both easy to navigate.",
      shortcut: `${shortcut("insert.marker", "M")}: Marker | ${shortcut("insert.regionFromSelection", "Shift+R")}: Region from Selection`,
    },
    "editing.crossfades": {
      title: "Crossfade Editor",
      description:
        "Use the Crossfade Editor to shape transitions between clips more precisely than a quick drag fade, especially for comping and cleanup work.",
    },
    "scripting": {
      title: "Scripting & Command Palette",
      description:
        "Use the Script Editor for extensibility and the Command Palette to find actions without memorizing every menu or shortcut.",
      shortcut: commandPalettePath,
    },
    "scripting.lua": {
      title: "Script Editor",
      description:
        "The Script Editor is the Lua-based automation and utility environment for building custom workflows, project tools, and repeatable actions.",
      shortcut: commandPalettePath,
    },
    "customization": {
      title: "Preferences, Mouse Modifiers & Themes",
      description:
        "Preferences control editing, display, backup, and mouse-modifier behavior. Theme and toolbar tools let you adapt the workspace to your own workflow.",
      shortcut: `${preferencesShortcut}: Preferences`,
    },
    "customization.themeEditor": {
      title: "Theme Editor",
      description:
        "The Theme Editor lets you tune the look of the workspace instead of being locked to the built-in presets. Use it when you want stronger visual contrast or a more personal layout feel.",
    },
    "customization.toolbarEditor": {
      title: "Toolbar Editor",
      description:
        "Use the Toolbar Editor to tailor the main toolbar to the actions you reach for most often, reducing menu-diving in repetitive workflows.",
    },
    "customization.screensets": {
      title: "Screensets",
      description:
        "Screensets store alternate workspace layouts so you can jump quickly between editing, mixing, mastering, or other task-focused views.",
      shortcut: `${shortcut("view.loadScreenset1", "Ctrl+1")} / ${shortcut("view.saveScreenset1", "Ctrl+Shift+1")}`,
    },
    "customization.mouseModifiers": {
      title: "Mouse Modifiers",
      description:
        "Mouse modifiers in Preferences let you adapt click-and-drag behavior to your own editing habits without changing the core timeline model.",
      shortcut: preferencesShortcut,
    },
    "shortcuts": {
      title: "Keyboard Shortcuts",
      description:
        "The Keyboard Shortcuts window is the searchable reference for default and custom global bindings. Use it to review commands, print a cheat sheet, rebind global shortcuts, or reset them.",
      shortcut: `${keyboardShortcut}: Keyboard Shortcuts Window`,
    },
    "shortcuts.custom": {
      title: "Custom Shortcut Editing",
      description:
        "Custom shortcuts are edited in the Keyboard Shortcuts window, not in Preferences. Rebinding currently applies to global shortcuts; timeline- and editor-scoped shortcuts remain documented but not rebindable in this pass.",
      shortcut: `Open Keyboard Shortcuts from the Help menu, then choose Rebind on a global action`,
    },
    "settings.audio": {
      title: "Audio Settings",
      description:
        "Configure audio driver type, hardware devices, sample rate, and buffer size before recording. Low-latency audio setup starts here.",
    },
    "settings.preferences": {
      title: "Preferences",
      description:
        "Use Preferences for editing, display, mouse, and backup settings. Shortcut rebinding lives in Keyboard Shortcuts, while mouse behavior lives in the Mouse tab here.",
      shortcut: preferencesShortcut,
    },
    "settings.timecode": {
      title: "Timecode & Big Clock",
      description:
        "Timecode settings and the Big Clock help when you need larger visual timing feedback, alternate display formats, or external sync-oriented workflow checks.",
    },
    "metering.loudness": {
      title: "Loudness Meter",
      description:
        "The loudness meter helps you judge integrated and short-term loudness for delivery targets instead of relying on peak level alone.",
    },
    "metering.phase": {
      title: "Phase Correlation Meter",
      description:
        "Use the phase correlation meter to watch stereo compatibility and quickly spot mono-collapse or polarity issues while mixing.",
    },
    "video.window": {
      title: "Video Window",
      description:
        "The Video Window supports scoring-to-picture and other timeline-to-video workflows by keeping playback in view alongside the edit session.",
    },
    "session.clipLauncher": {
      title: "Clip Launcher / Session View",
      description:
        "The Clip Launcher gives you a performance-oriented session view for triggering clips and experimenting with arrangement ideas outside the linear timeline alone.",
    },
  };
}

export function getHelpText(elementId: string): HelpEntry | undefined {
  return buildHelpTexts()[elementId];
}

export function getAllHelpTexts(): Record<string, HelpEntry> {
  return buildHelpTexts();
}
