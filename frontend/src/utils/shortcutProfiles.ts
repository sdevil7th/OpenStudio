import type { ShortcutPlatform } from "./platform";

export const KEYBOARD_SHORTCUT_PROFILE_IDS = [
  "openstudio",
  "pro_tools",
  "cubase",
  "reaper",
  "audacity",
  "logic_pro",
  "fl_studio",
  "ableton_live",
  "studio_one",
  "bitwig_studio",
  "reason",
  "cakewalk_sonar",
  "garageband",
  "digital_performer",
  "ardour",
  "adobe_audition",
  "mixcraft",
  "waveform",
  "renoise",
] as const;

export type KeyboardShortcutProfileId = typeof KEYBOARD_SHORTCUT_PROFILE_IDS[number];

export interface PlatformShortcutBindings {
  common?: readonly string[];
  macos?: readonly string[];
  windows?: readonly string[];
  linux?: readonly string[];
  other?: readonly string[];
}

export type ProfileActionBindings = readonly string[] | PlatformShortcutBindings;

export type ProfileShortcutScope =
  | "global"
  | "timeline"
  | "timeline_ruler"
  | "track_control_panel"
  | "mixer"
  | "pitch_editor"
  | "piano_roll"
  | "automation"
  | "browser"
  | "plugin"
  | "modal"
  | "contextual";

export interface KeyboardShortcutProfile {
  id: KeyboardShortcutProfileId;
  name: string;
  shortName: string;
  description: string;
  /** Platforms on which the source DAW itself is available. The profile remains usable everywhere. */
  nativePlatforms: readonly ShortcutPlatform[];
  /** Extra dispatch scopes required by a source profile's documented command semantics. */
  scopeAdditions?: Readonly<Record<string, readonly ProfileShortcutScope[]>>;
  /**
   * `openstudio` keeps an action's built-in binding when this profile does not
   * mention it. `strict` leaves every unmentioned action unassigned. Strict
   * profiles are reserved for sources whose published/default map is either
   * intentionally incomplete or too focus-dependent to inherit safely.
   */
  fallbackPolicy?: "openstudio" | "strict";
  /**
   * Documented differences from OpenStudio are listed here. An empty array is
   * an intentional unbind: it prevents a source-DAW collision or a merely
   * similar OpenStudio action from being presented as equivalent. Actions not
   * present here retain their OpenStudio fallback.
   */
  bindings: Readonly<Record<string, ProfileActionBindings>>;
}

const keys = (...bindings: string[]): readonly string[] => bindings;
const platformKeys = (
  common: readonly string[],
  macos: readonly string[] = [],
  windows: readonly string[] = [],
  linux: readonly string[] = [],
): PlatformShortcutBindings => ({ common, macos, windows, linux });

export const KEYBOARD_SHORTCUT_PROFILES: readonly KeyboardShortcutProfile[] = [
  {
    id: "openstudio",
    name: "OpenStudio",
    shortName: "OpenStudio",
    description: "The complete OpenStudio key map, designed to be portable across macOS and Windows.",
    nativePlatforms: ["macos", "windows", "linux"],
    bindings: {},
  },
  {
    id: "pro_tools",
    name: "Pro Tools",
    shortName: "Pro Tools",
    description: "Pro Tools 2026.4-style editing and navigation, with OpenStudio fallbacks for unmapped commands.",
    nativePlatforms: ["macos", "windows"],
    bindings: {
      "automation.toggleArrangementView": keys(),
      "transport.record": keys("Ctrl+Space", "F12", "Numpad3"),
      "transport.rewind": keys("Enter"),
      "edit.undo": keys("Ctrl+Z"),
      "edit.redo": keys("Ctrl+Shift+Z"),
      "edit.cut": keys("Ctrl+X"),
      "edit.copy": keys("Ctrl+C"),
      "edit.paste": keys("Ctrl+V"),
      "edit.delete": keys("Backspace", "Delete"),
      "edit.duplicateClips": keys("Ctrl+D"),
      "edit.splitAtCursor": keys("Ctrl+E"),
      "edit.groupClips": platformKeys([], ["Ctrl+Option+G"], ["Ctrl+Alt+G"]),
      "edit.ungroupClips": platformKeys([], ["Ctrl+Option+U"], ["Ctrl+Alt+U"]),
      "edit.muteClips": keys("Ctrl+M"),
      "edit.toggleClipLock": keys("Ctrl+L"),
      "view.setLoopToSelection": keys(),
      "insert.multipleTracks": keys("Ctrl+Shift+N"),
      "tools.selectTool": keys("F7"),
      // Pro Tools has a Separate command, not a persistent split tool. Do not inherit OpenStudio B.
      "tools.splitTool": keys(),
      "view.zoomOut": keys("R"),
      "view.zoomIn": keys("T"),
      "track.toggleSelectedArm": keys(),
      "midi.tool.range": keys(),
      "view.toggleMixer": keys("Ctrl+="),
      "file.new": keys("Ctrl+N"),
      "file.open": keys("Ctrl+O"),
      "file.save": keys("Ctrl+S"),
      "file.saveAs": keys("Ctrl+Shift+S"),
    },
  },
  {
    id: "cubase",
    name: "Cubase / Nuendo",
    shortName: "Cubase",
    description: "Cubase/Nuendo 15 transport, tool, quantize, snap, and window conventions.",
    nativePlatforms: ["macos", "windows"],
    bindings: {
      "automation.toggleArrangementView": keys(),
      "transport.record": keys("NumpadMultiply"),
      "transport.loop": keys("NumpadDivide"),
      "transport.rewind": keys("NumpadDecimal"),
      "tools.selectTool": keys("1"),
      "tools.splitTool": keys("3"),
      "tools.muteTool": keys("7"),
      "edit.quantizeToGrid": keys("Q"),
      "midi.quantizeLast": keys("Q"),
      "view.toggleSnap": keys("J"),
      "view.toggleMixer": keys("F3"),
      "view.toggleVirtualKeyboard": platformKeys([], ["Option+K"], ["Alt+K"], ["Alt+K"]),
      "insert.marker": keys("Insert"),
      "insert.markerNamed": keys(),
      "insert.mediaFile": keys("Ctrl+Alt+I"),
      "edit.duplicateClips": keys("Ctrl+D"),
      "edit.groupClips": keys("Ctrl+G"),
      "edit.ungroupClips": keys("Ctrl+U"),
      // Cubase has separate Mute/Unmute commands (Shift+M/Shift+U). Do not
      // substitute a direction-ambiguous toggle.
      "edit.muteClips": keys(),
      "edit.muteSelectedClips": keys("Shift+M"),
      "edit.unmuteSelectedClips": keys("Shift+U"),
      "edit.splitAtCursor": platformKeys([], ["Option+X"], ["Alt+X"]),
      "view.zoomIn": keys("H"),
      "view.zoomOut": keys("G"),
      "view.zoomToFit": keys("Shift+F"),
      "view.zoomToSelection": platformKeys([], ["Option+S"], ["Alt+S"]),
      "file.new": keys("Ctrl+N"),
      "file.open": keys("Ctrl+O"),
      "file.save": keys("Ctrl+S"),
      "file.saveAs": keys("Ctrl+Shift+S"),
    },
  },
  {
    id: "reaper",
    name: "REAPER",
    shortName: "REAPER",
    description: "REAPER 7.79 default mnemonic editing, track, marker, snap, and render conventions.",
    nativePlatforms: ["macos", "windows", "linux"],
    bindings: {
      "automation.toggleArrangementView": keys(),
      "transport.record": keys("Ctrl+R"),
      "transport.rewind": keys("W"),
      "transport.loop": keys("R"),
      "track.toggleSelectedArm": keys(),
      "midi.tool.range": keys(),
      "edit.splitAtCursor": keys("S"),
      "edit.duplicateClips": keys("Ctrl+D"),
      "edit.groupClips": keys("G"),
      "edit.ungroupClips": keys("U"),
      "edit.muteClips": keys("Ctrl+M"),
      "insert.audioTrack": keys("Ctrl+T"),
      "insert.marker": keys("M"),
      "insert.regionFromSelection": keys("Shift+R"),
      "midi.tool.mute": keys(),
      "track.toggleSelectedMute": keys(),
      "midi.repeatSelection": keys(),
      "insert.mediaFile": keys("Insert"),
      "view.toggleMixer": keys("Ctrl+M"),
      "view.toggleSnap": platformKeys([], ["Option+S"], ["Alt+S"], ["Alt+S"]),
      "view.toggleVirtualKeyboard": platformKeys([], ["Option+B"], ["Alt+B"], ["Alt+B"]),
      "file.render": platformKeys([], ["Ctrl+Option+R"], ["Ctrl+Alt+R"], ["Ctrl+Alt+R"]),
      "options.preferences": keys("Ctrl+P"),
      "view.zoomIn": keys("Shift++", "NumpadAdd", "Up"),
      "view.zoomOut": keys("-", "NumpadSubtract", "Down"),
      "edit.normalizeClips": keys("N"),
      "edit.reverseClip": platformKeys([], ["Option+R"], ["Alt+R"], ["Alt+R"]),
      "view.toggleAutoCrossfade": platformKeys([], ["Option+X"], ["Alt+X"], ["Alt+X"]),
      "edit.nudgeLeft": keys("Numpad4"),
      "edit.nudgeRight": keys("Numpad6"),
      // REAPER assigns modified arrows to navigation/zoom actions, not this
      // profile's fine clip-nudge operation.
      "edit.nudgeLeftFine": keys(),
      "edit.nudgeRightFine": keys(),
    },
  },
  {
    id: "audacity",
    name: "Audacity",
    shortName: "Audacity",
    description: "Audacity transport, selection, split, label, and zoom conventions.",
    nativePlatforms: ["macos", "windows", "linux"],
    bindings: {
      "automation.toggleArrangementView": keys(),
      "transport.record": keys("R"),
      "transport.pause": keys("P"),
      // R is global Record in Audacity; do not let OpenStudio's scoped track
      // arm/range fallbacks shadow it while focus is in the TCP, Mixer, or Piano Roll.
      "track.toggleSelectedArm": keys(),
      "midi.tool.range": keys(),
      "transport.rewind": keys("Home"),
      "transport.loop": keys("L"),
      "midi.tool.line": keys(),
      "tools.selectTool": keys("F1"),
      "tools.smartTool": keys("F6"),
      "edit.editPitch": keys(),
      "edit.splitAtCursor": keys("Ctrl+I"),
      "edit.duplicateClips": keys("Ctrl+D"),
      "insert.marker": keys("Ctrl+B"),
      "view.zoomIn": keys("Ctrl+1"),
      "view.zoomOut": keys("Ctrl+3"),
      "view.zoomToSelection": keys("Ctrl+E"),
      "view.zoomToFit": keys("Ctrl+F"),
      "file.new": keys("Ctrl+N"),
      "file.open": keys("Ctrl+O"),
      "file.save": keys("Ctrl+S"),
    },
  },
  {
    id: "logic_pro",
    name: "Logic Pro",
    shortName: "Logic Pro",
    description: "Logic Pro transport, cycle, region, nudge, mixer, and editor conventions.",
    nativePlatforms: ["macos"],
    scopeAdditions: {
      "track.toggleSelectedMute": ["timeline"],
    },
    bindings: {
      "transport.record": keys("R"),
      "track.toggleSelectedArm": keys(),
      "midi.tool.range": keys(),
      "transport.rewind": keys("Enter"),
      "transport.loop": keys("C"),
      "midi.stepInputC": keys(),
      // Logic's single-letter editor commands are not persistent OpenStudio tools.
      "tools.selectTool": keys(),
      "tools.splitTool": keys(),
      "tools.muteTool": keys(),
      "tools.smartTool": keys(),
      "edit.splitAtCursor": keys("Ctrl+T"),
      "edit.splitAtSelection": platformKeys([], ["Option+Ctrl+T"], ["Alt+Ctrl+T"]),
      "edit.duplicateClips": keys("Ctrl+R"),
      "edit.muteClips": platformKeys([], ["Control+M"], ["Ctrl+M"]),
      "edit.nudgeLeft": platformKeys([], ["Option+Left"], ["Alt+Left"]),
      "edit.nudgeRight": platformKeys([], ["Option+Right"], ["Alt+Right"]),
      // Logic changes region/event length with Option+Shift+Arrow; it is not
      // a fine position nudge.
      "edit.nudgeLeftFine": keys(),
      "edit.nudgeRightFine": keys(),
      "edit.quantizeToGrid": keys("Q"),
      "edit.reverseClip": platformKeys([], ["Control+Shift+R"], ["Ctrl+Shift+R"]),
      "view.toggleSnap": keys("Ctrl+G"),
      "edit.groupClips": keys(),
      "view.toggleMixer": keys("X"),
      "view.toggleVirtualKeyboard": keys("Ctrl+K"),
      "track.toggleSelectedMute": keys("M"),
      // Tab/Shift+Tab cycle Logic window areas; they are not transient-search commands.
      "navigate.nextTransient": keys(),
      "navigate.prevTransient": keys(),
      // M belongs to the selected channel strip, not Add Marker.
      "insert.marker": keys(),
      "automation.toggleArrangementView": keys("A"),
      // Logic's automation mode shortcuts use the physical Control+Command
      // pair. Keep both modifiers explicit so Control is not collapsed into
      // OpenStudio's legacy secondary-modifier vocabulary.
      "automation.selectedTracks.toggleOffRead": platformKeys(
        [],
        ["Control+Command+O"],
        ["Control+Meta+O"],
      ),
      "automation.selectedTracks.toggleLatchRead": platformKeys(
        [],
        ["Control+Command+A"],
        ["Control+Meta+A"],
      ),
      "automation.allTracks.mode.off": platformKeys(
        [],
        ["Control+Command+Shift+O"],
        ["Control+Meta+Shift+O"],
      ),
      "automation.allTracks.mode.read": platformKeys(
        [],
        ["Control+Command+Shift+R"],
        ["Control+Meta+Shift+R"],
      ),
      "automation.allTracks.mode.touch": platformKeys(
        [],
        ["Control+Command+Shift+T"],
        ["Control+Meta+Shift+T"],
      ),
      "automation.allTracks.mode.latch": platformKeys(
        [],
        ["Control+Command+Shift+L"],
        ["Control+Meta+Shift+L"],
      ),
      // P is Logic's Piano Roll toggle, not OpenStudio's pitch editor.
      "edit.editPitch": keys(),
      "view.togglePianoRoll": keys("P"),
      // Cmd+A operates on regions/events in the focused editor, never on the
      // OpenStudio-only selected-track collection.
      "edit.selectAllTracks": keys(),
      "edit.selectAllClips": keys("Ctrl+A"),
      // Logic's Piano Roll does not use OpenStudio's persistent one-letter
      // tool aliases. Cmd+R is the exact Repeat command in editor context.
      "midi.closeEditor": keys(),
      "midi.tool.draw": keys(),
      "midi.tool.select": keys(),
      "midi.tool.erase": keys(),
      "midi.tool.trim": keys(),
      "midi.tool.split": keys(),
      "midi.tool.glue": keys(),
      "midi.tool.mute": keys(),
      "midi.tool.velocity": keys(),
      "midi.tool.line": keys(),
      "midi.tool.zoom": keys(),
      "midi.tool.pan": keys(),
      "midi.repeatSelection": keys("Ctrl+R"),
      "midi.duplicateSelection": keys(),
      "insert.multipleTracks": platformKeys([], ["Option+Ctrl+N"], ["Alt+Ctrl+N"]),
      "insert.audioTrack": platformKeys([], ["Option+Ctrl+A"], ["Alt+Ctrl+A"]),
      "insert.instrumentTrack": platformKeys([], ["Option+Ctrl+S"], ["Alt+Ctrl+S"]),
      "insert.mediaFile": keys("Ctrl+I"),
      "view.zoomIn": keys("Ctrl+Right"),
      "view.zoomOut": keys("Ctrl+Left"),
      // These OpenStudio zoom/screenset chords are native Logic window/export
      // commands. Leave them unassigned until exact window actions exist.
      "view.zoomToSelection": keys(),
      "view.zoomToFit": keys(),
      "view.loadScreenset1": keys(),
      "view.loadScreenset2": keys(),
      "view.loadScreenset3": keys(),
      "view.saveScreenset1": keys(),
      "view.saveScreenset2": keys(),
      "view.saveScreenset3": keys(),
      "options.tapTempo": keys(),
      "file.projectSettings": platformKeys([], ["Option+P"], ["Alt+P"]),
      "file.closeProject": platformKeys([], ["Command+Option+W"], ["Ctrl+Alt+W"]),
      "file.newFromTemplate": keys("Ctrl+N"),
      "file.new": keys("Ctrl+Shift+N"),
      "file.open": keys("Ctrl+O"),
      "file.save": keys("Ctrl+S"),
      "file.saveAs": keys("Ctrl+Shift+S"),
    },
  },
  {
    id: "fl_studio",
    name: "FL Studio",
    shortName: "FL Studio",
    description: "FL Studio Playlist tools, duplication, quantize, marker, mixer, and Piano Roll conventions.",
    nativePlatforms: ["macos", "windows"],
    scopeAdditions: {
      // FL's Backspace snap command is application-wide, including while the
      // Piano Roll owns focus.
      "view.toggleSnap": ["global"],
    },
    bindings: {
      "automation.toggleArrangementView": keys(),
      "transport.record": keys("R"),
      "track.toggleSelectedArm": keys(),
      "midi.tool.range": keys(),
      // L changes Pattern/Song mode in FL Studio; it must not inherit OpenStudio loop.
      "transport.loop": keys(),
      "tools.selectTool": keys("E"),
      "tools.splitTool": keys("C"),
      "tools.muteTool": keys("T"),
      // Playlist selection is clip/event selection, not OpenStudio track selection.
      "edit.selectAllTracks": keys(),
      "edit.selectAllClips": keys("Ctrl+A"),
      // FL uses Ctrl+D to deselect, but OpenStudio's current Deselect All action
      // only clears tracks. Do not expose that false equivalent on Esc.
      "edit.deselectAll": keys(),
      "edit.splitAtCursor": keys("Insert"),
      // Backspace toggles FL's global snap mode; Delete remains the destructive
      // key so the inherited Backspace deletion alias cannot shadow it.
      "edit.delete": keys("Delete"),
      "midi.deleteSelection": keys("Delete"),
      "automation.point.deleteSelected": keys("Delete"),
      "view.toggleSnap": keys("Backspace"),
      "edit.duplicateClips": keys("Ctrl+B"),
      "edit.quantizeToGrid": keys("Shift+Q"),
      "midi.quantizeLast": keys("Ctrl+Q"),
      // FL has separate Mute/Unmute commands; do not replace them with a
      // direction-ambiguous toggle.
      "edit.muteClips": keys(),
      "edit.muteSelectedClips": platformKeys([], ["Option+M"], ["Alt+M"]),
      "edit.unmuteSelectedClips": platformKeys([], ["Option+Shift+M"], ["Alt+Shift+M"]),
      "edit.groupClips": keys("Shift+G"),
      "edit.ungroupClips": platformKeys([], ["Option+G"], ["Alt+G"]),
      "insert.marker": platformKeys(["Ctrl+T"], ["Option+T"], ["Alt+T"]),
      "insert.audioTrack": keys(),
      "transport.metronome": keys("Ctrl+M"),
      "midi.panic": keys("Ctrl+H"),
      "file.render": keys("Ctrl+R"),
      "file.exportMIDI": keys("Ctrl+Shift+M"),
      "view.toggleMixer": keys("F9"),
      "view.togglePianoRoll": keys("F7"),
      // F7 is FL's Piano Roll, not OpenStudio's Drum Editor.
      "view.drumEditor": keys(),
      // Native FL editor/window commands own these inherited OpenStudio chords.
      "file.closeProject": keys(),
      "view.clipProperties": keys(),
      "view.setLoopToSelection": keys(),
      "view.toggleVirtualKeyboard": keys(),
      "view.toggleUndoHistory": keys(),
      "view.loadScreenset1": keys(),
      "view.loadScreenset2": keys(),
      "view.loadScreenset3": keys(),
      "view.saveScreenset1": keys(),
      "view.saveScreenset2": keys(),
      "view.saveScreenset3": keys(),
      "options.tapTempo": keys(),
      "insert.markerNamed": keys(),
      "insert.regionFromSelection": keys(),
      "track.toggleSelectedMute": keys(),
      "track.toggleSelectedSolo": keys(),
      // FL Playlist movement uses Shift+Arrow. Ctrl+Arrow selects time and must
      // never fall through to OpenStudio's fine clip nudge.
      "edit.nudgeLeft": keys("Shift+Left"),
      "edit.nudgeRight": keys("Shift+Right"),
      "edit.nudgeLeftFine": keys(),
      "edit.nudgeRightFine": keys(),
      // FL Piano Roll tool aliases are P/E/D/C/T/Z. B and Y are Paint and
      // Playback tools that OpenStudio cannot represent exactly yet.
      "midi.tool.draw": keys("P"),
      "midi.tool.select": keys("E"),
      "midi.tool.erase": keys("D"),
      "midi.tool.trim": keys(),
      "midi.tool.split": keys("C"),
      "midi.tool.glue": keys(),
      "midi.tool.mute": keys("T"),
      "midi.tool.velocity": keys(),
      "midi.tool.line": keys(),
      "midi.tool.zoom": keys("Z"),
      "midi.tool.pan": keys(),
      "midi.repeatSelection": keys(),
      "midi.duplicateSelection": keys("Ctrl+B"),
      "midi.deselectAll": keys("Ctrl+D"),
      "midi.glueSelectedNotes": keys("Ctrl+G"),
      "midi.moveLeft": keys(),
      "midi.moveRight": keys(),
      "midi.moveLeftFine": keys("Shift+Left"),
      "midi.moveRightFine": keys("Shift+Right"),
      "midi.movePitchUp": keys("Shift+Up"),
      "midi.movePitchDown": keys("Shift+Down"),
      "midi.movePitchOctaveUp": keys("Ctrl+Up"),
      "midi.movePitchOctaveDown": keys("Ctrl+Down"),
      "view.zoomIn": keys("PageUp"),
      "view.zoomOut": keys("PageDown"),
      "view.zoomToFit": keys("Shift+4"),
      "view.zoomToSelection": keys("Shift+5"),
      // Ctrl/Cmd+N saves a new version in FL Studio; no New Project default is claimed.
      "file.new": keys(),
      "file.open": keys("Ctrl+O"),
      "file.save": keys("Ctrl+S"),
      "file.saveAs": keys("Ctrl+Shift+S"),
    },
  },
  {
    id: "ableton_live",
    name: "Ableton Live",
    shortName: "Ableton",
    description: "Ableton Live arrangement editing, grid, loop, marker, and track conventions.",
    nativePlatforms: ["macos", "windows"],
    scopeAdditions: {
      "track.toggleSelectedSolo": ["timeline"],
    },
    bindings: {
      "transport.record": keys("F9"),
      "transport.loop": keys("Ctrl+L"),
      "view.setLoopToSelection": keys(),
      // B is Draw Mode; Live has a split command but no persistent split tool.
      "tools.selectTool": keys(),
      "tools.splitTool": keys(),
      "midi.tool.draw": keys("B"),
      "midi.tool.split": keys(),
      "edit.splitAtCursor": keys("Ctrl+E"),
      "edit.duplicateClips": keys("Ctrl+D"),
      "edit.muteClips": keys("0"),
      // Live's Command/Ctrl+G groups tracks; it does not group clips.
      "edit.groupClips": keys(),
      "edit.ungroupClips": keys(),
      "track.groupSelectedIntoFolder": keys("Ctrl+G"),
      "edit.insertSilence": keys("Ctrl+I"),
      "insert.audioTrack": keys("Ctrl+T"),
      "insert.midiTrack": keys("Ctrl+Shift+T"),
      "insert.emptyMidiClip": keys("Ctrl+Shift+M"),
      // Live has no default Add Locator shortcut.
      "insert.marker": keys(),
      "view.toggleSnap": keys("Ctrl+4"),
      "view.toggleVirtualKeyboard": keys("M"),
      "midi.tool.mute": keys(),
      "track.toggleSelectedMute": keys(),
      "view.toggleMixer": platformKeys([], ["Ctrl+Option+M"], ["Ctrl+Alt+M"]),
      "view.mediaExplorer": platformKeys([], ["Ctrl+Option+B"], ["Ctrl+Alt+B"]),
      "automation.toggleArrangementView": keys("A"),
      "automation.point.selectNext": platformKeys(["Tab"], ["Option+Right"], ["Alt+Right"]),
      "automation.point.selectPrevious": platformKeys(["Shift+Tab"], ["Option+Left"], ["Alt+Left"]),
      "automation.point.deleteSelected": keys("Delete"),
      "automation.point.addAtPlayhead": keys("Enter"),
      "automation.lane.selectPrevious": platformKeys([], ["Option+Up"], ["Alt+Up"]),
      "automation.lane.selectNext": platformKeys([], ["Option+Down"], ["Alt+Down"]),
      "track.toggleSelectedSolo": keys("S"),
      "midi.quantizeLast": keys("Ctrl+U"),
      "view.zoomToSelection": keys("Z"),
      "view.zoomToFit": keys("W"),
    },
  },
  {
    id: "studio_one",
    name: "Studio One",
    shortName: "Studio One",
    description: "Studio One Pro 7 single-key tools, quantize, snap, marker, track, and mixer layout.",
    nativePlatforms: ["macos", "windows"],
    scopeAdditions: {
      "track.toggleSelectedAutomation": ["timeline"],
    },
    bindings: {
      "transport.record": keys("NumpadMultiply"),
      "transport.loop": keys("NumpadDivide"),
      "transport.rewind": keys("NumpadComma"),
      "tools.selectTool": keys("1"),
      "tools.splitTool": keys("3"),
      "tools.muteTool": keys("6"),
      "edit.splitAtCursor": platformKeys([], ["Option+X"], ["Alt+X"]),
      "edit.duplicateClips": keys("D"),
      // Studio One exposes separate Mute/Unmute Event commands.
      "edit.muteClips": keys(),
      "edit.muteSelectedClips": keys("Shift+M"),
      "edit.unmuteSelectedClips": keys("Shift+U"),
      "insert.markerNamed": keys(),
      "edit.quantizeToGrid": keys("Q"),
      "edit.normalizeClips": platformKeys([], ["Option+N"], ["Alt+N"]),
      "edit.reverseClip": keys("Ctrl+R"),
      "view.toggleSnap": keys("N"),
      "track.toggleSelectedAutomation": keys("A"),
      // A belongs to Studio One's selected-track envelope display command,
      // not the generic arrangement automation toggle.
      "automation.toggleArrangementView": keys(),
      "track.toggleSelectedAutomationRead": keys("J"),
      "automation.selectedTracks.mode.touch": keys("K"),
      "view.toggleMixer": keys("F3"),
      "view.zoomIn": keys("E"),
      "view.zoomOut": keys("W"),
      "view.zoomToSelection": keys("Shift+S"),
      "view.zoomToFit": platformKeys([], ["Option+Z"], ["Alt+Z"]),
      // T opens Add Tracks, rather than directly creating one audio track.
      "insert.audioTrack": keys(),
      "insert.multipleTracks": keys("T"),
      "midi.tool.trim": keys(),
      "insert.marker": keys("Insert"),
      "insert.mediaFile": keys("Ctrl+Alt+I"),
      "options.tapTempo": platformKeys([], ["Option+T"], ["Alt+T"]),
      "file.render": keys("Ctrl+E"),
      "file.saveAs": platformKeys([], ["Ctrl+Option+S"], ["Ctrl+Alt+S"]),
    },
  },
  {
    id: "bitwig_studio",
    name: "Bitwig Studio",
    shortName: "Bitwig",
    description: "Bitwig Studio transport, tool, duplication, quantize, and editor conventions.",
    nativePlatforms: ["macos", "windows", "linux"],
    bindings: {
      "automation.toggleArrangementView": keys(),
      "transport.record": keys("R"),
      "track.toggleSelectedArm": keys(),
      "midi.tool.range": keys(),
      "transport.loop": keys("Shift+L"),
      "tools.selectTool": keys("1"),
      "tools.splitTool": keys("5"),
      "edit.splitAtCursor": keys("Ctrl+E"),
      "edit.duplicateClips": keys("Ctrl+D"),
      // Bitwig's chords group and unpack tracks, not timeline clips.
      "edit.groupClips": keys(),
      "edit.ungroupClips": keys(),
      "track.groupSelectedIntoFolder": keys("Ctrl+G"),
      "edit.quantizeToGrid": keys("Q"),
      "midi.quantizeLast": keys("Q"),
      "view.zoomIn": keys("Shift++", "Ctrl++", "Ctrl+="),
      "view.zoomOut": keys("-", "Ctrl+-"),
    },
  },
  {
    id: "reason",
    name: "Reason",
    shortName: "Reason",
    description: "Reason sequencer transport, loop, snap, metronome, and zoom conventions.",
    nativePlatforms: ["macos", "windows"],
    bindings: {
      "automation.toggleArrangementView": keys(),
      "transport.record": keys("NumpadMultiply"),
      "transport.loop": keys("L"),
      "transport.metronome": keys("C"),
      "midi.tool.line": keys(),
      "midi.stepInputC": keys(),
      "tools.selectTool": keys("Q"),
      "tools.splitTool": keys("R"),
      "tools.muteTool": keys("T"),
      "tools.smartTool": keys(),
      "track.toggleSelectedArm": keys(),
      "midi.tool.range": keys(),
      "edit.splitAtCursor": platformKeys([], ["Option+X"], ["Alt+X"]),
      "edit.muteClips": keys("M"),
      "edit.quantizeToGrid": keys("Ctrl+K"),
      // These Reason chords route/auto-group tracks, not clips.
      "edit.groupClips": keys(),
      "edit.ungroupClips": keys(),
      "edit.nudgeLeft": keys("Ctrl+Left"),
      "edit.nudgeRight": keys("Ctrl+Right"),
      "edit.nudgeLeftFine": platformKeys([], ["Ctrl+Option+Left"], ["Ctrl+Alt+Left"]),
      "edit.nudgeRightFine": platformKeys([], ["Ctrl+Option+Right"], ["Ctrl+Alt+Right"]),
      "insert.audioTrack": keys("Ctrl+T"),
      "insert.instrumentTrack": keys("Ctrl+I"),
      "view.toggleSnap": keys("S"),
      "view.zoomIn": keys("H", "Ctrl+="),
      "view.zoomOut": keys("G", "Ctrl+-"),
    },
  },
  {
    id: "cakewalk_sonar",
    name: "Cakewalk / Sonar",
    shortName: "Cakewalk",
    description: "Cakewalk/Sonar transport, tool, snap, split, and selected-track conventions.",
    nativePlatforms: ["windows"],
    scopeAdditions: {
      "track.toggleSelectedMute": ["timeline"],
      "track.toggleSelectedSolo": ["timeline"],
      "track.toggleSelectedArm": ["timeline"],
      "track.toggleSelectedAutomation": ["timeline"],
    },
    bindings: {
      "automation.toggleArrangementView": keys(),
      "transport.record": keys("R"),
      "transport.loop": keys("L"),
      "midi.tool.line": keys(),
      "transport.rewind": keys("W"),
      "transport.metronome": keys("Ctrl+F3"),
      "tools.smartTool": keys("F5"),
      "tools.selectTool": keys("F6"),
      // F8 and F10 cycle several Cakewalk tools and cannot be represented as
      // one persistent OpenStudio tool. B and X have unrelated native uses.
      "tools.splitTool": keys(),
      "tools.muteTool": keys(),
      "edit.splitAtCursor": keys("S"),
      "edit.muteClips": keys("K"),
      "edit.toggleClipLock": keys("Ctrl+K"),
      "edit.editPitch": keys(),
      "edit.nudgeLeft": keys("Numpad1"),
      "edit.nudgeRight": keys("Numpad3"),
      "edit.nudgeLeftFine": keys(),
      "edit.nudgeRightFine": keys(),
      "view.toggleSnap": keys("N"),
      "view.toggleMixer": platformKeys([], ["Option+2"], ["Alt+2"], ["Alt+2"]),
      "view.mediaExplorer": keys("B"),
      "midi.tool.split": keys(),
      "midi.stepInputB": keys(),
      "view.toggleVirtualKeyboard": platformKeys([], ["Option+0"], ["Alt+0"], ["Alt+0"]),
      "view.zoomOut": keys("Ctrl+Left"),
      "view.zoomIn": keys("Ctrl+Right"),
      "view.zoomToFit": keys("Ctrl+F"),
      "insert.audioTrack": keys("Ctrl+T"),
      "insert.midiTrack": keys("Ctrl+Shift+T"),
      "insert.marker": keys("M"),
      "midi.tool.mute": keys(),
      "clip.openSelectedInPianoRoll": platformKeys([], ["Option+3"], ["Alt+3"], ["Alt+3"]),
      "options.preferences": keys("P"),
      "track.toggleSelectedMute": platformKeys([], ["Option+M"], ["Alt+M"], ["Alt+M"]),
      "track.toggleSelectedSolo": platformKeys([], ["Option+S"], ["Alt+S"], ["Alt+S"]),
      "track.toggleSelectedArm": platformKeys([], ["Option+R"], ["Alt+R"], ["Alt+R"]),
      "track.toggleSelectedAutomation": keys("Shift+A"),
      "automation.allTracks.writeOff": keys("F12"),
      "automation.allTracks.toggleRead": keys("Ctrl+F12"),
      "midi.tool.range": keys(),
    },
  },
  {
    id: "garageband",
    name: "GarageBand",
    shortName: "GarageBand",
    description: "GarageBand transport, cycle, snap, track-state, and horizontal zoom conventions.",
    nativePlatforms: ["macos"],
    scopeAdditions: {
      "track.toggleSelectedMute": ["timeline"],
      "track.toggleSelectedSolo": ["timeline"],
      "track.toggleSelectedArm": ["timeline"],
      "track.toggleSelectedMonitor": ["timeline"],
      "track.duplicateSelected": ["timeline"],
    },
    bindings: {
      "transport.record": keys("R"),
      "transport.loop": keys("C"),
      "midi.stepInputC": keys(),
      "midi.stepInputD": keys(),
      "midi.stepInputE": keys(),
      "midi.stepInputF": keys(),
      "midi.stepInputG": keys(),
      "midi.stepInputA": keys(),
      "midi.stepInputB": keys(),
      "midi.stepInputCSharp": keys(),
      "midi.stepInputDSharp": keys(),
      "midi.stepInputESharp": keys(),
      "midi.stepInputFSharp": keys(),
      "midi.stepInputGSharp": keys(),
      "midi.stepInputASharp": keys(),
      "midi.stepInputBSharp": keys(),
      "transport.metronome": keys("K"),
      "track.toggleSelectedArm": platformKeys([], ["Control+R"], ["Ctrl+R"]),
      "track.toggleSelectedMonitor": platformKeys([], ["Control+I"], ["Ctrl+I"]),
      "midi.tool.range": keys(),
      // A/C/B belong to Automation/Cycle/Smart Controls in GarageBand.
      "tools.selectTool": keys(),
      "tools.splitTool": keys(),
      "tools.muteTool": keys(),
      // M/S are GarageBand track-state commands, not OpenStudio's inherited
      // marker/split commands. Keep them from changing unrelated data when
      // focus moves from a track strip into an editor.
      "insert.marker": keys(),
      "edit.splitAtCursor": keys("Ctrl+T"),
      "edit.duplicateClips": keys(),
      "track.duplicateSelected": keys("Ctrl+D"),
      "edit.selectAllTracks": keys(),
      "edit.selectAllClips": keys("Ctrl+A"),
      // GarageBand uses Shift+D to unselect regions/events. OpenStudio's
      // current Deselect All action clears only tracks, so do not mislabel it.
      "edit.deselectAll": keys(),
      // Plain arrows select adjacent regions/events in GarageBand; they do not
      // move clip content. Exact selection actions are tracked separately.
      "edit.nudgeLeft": keys(),
      "edit.nudgeRight": keys(),
      "edit.selectPreviousClip": keys("Left"),
      "edit.selectNextClip": keys("Right"),
      "navigate.nextTransient": keys(),
      "navigate.prevTransient": keys(),
      "midi.tool.mute": keys(),
      "tools.smartTool": keys(),
      "edit.editPitch": keys(),
      "view.togglePianoRoll": keys("P"),
      "edit.redo": keys("Ctrl+Shift+Z"),
      "view.toggleSnap": keys("Ctrl+G"),
      "view.toggleVirtualKeyboard": keys("Ctrl+K"),
      "view.toggleMasterTrackTCP": keys("Ctrl+Shift+M"),
      // Cmd+M minimizes the application; it is not GarageBand's mixer toggle.
      "view.toggleMixer": keys(),
      "automation.toggleArrangementView": keys("A"),
      "insert.multipleTracks": platformKeys([], ["Option+Ctrl+N"], ["Alt+Ctrl+N"]),
      "insert.audioTrack": platformKeys([], ["Option+Ctrl+A"], ["Alt+Ctrl+A"]),
      "insert.instrumentTrack": platformKeys([], ["Option+Ctrl+S"], ["Alt+Ctrl+S"]),
      "insert.mediaFile": keys("Ctrl+Shift+I"),
      // The same chord imports audio in GarageBand, so the OpenStudio quick-add
      // instrument fallback must not win first.
      "insert.quickAddInstrument": keys(),
      "view.zoomOut": keys("Ctrl+Left"),
      "view.zoomIn": keys("Ctrl+Right"),
      "track.toggleSelectedMute": keys("M"),
      "track.toggleSelectedSolo": keys("S"),
      // GarageBand uses Command+G for snap and Command+Arrow for zoom. Do not
      // retain OpenStudio edit commands on those same physical chords.
      "edit.groupClips": keys(),
      "edit.nudgeLeftFine": keys(),
      "edit.nudgeRightFine": keys(),
      "file.closeProject": keys("Ctrl+W"),
      "track.deleteSelected": keys("Ctrl+Delete"),
      "midi.panic": keys(),
      "file.openSafeMode": keys(),
      // GarageBand's editor is toggled with P/E. Its Piano Roll has no
      // OpenStudio-style persistent one-letter tool map.
      "midi.closeEditor": keys(),
      "midi.tool.draw": keys(),
      "midi.tool.select": keys(),
      "midi.tool.erase": keys(),
      "midi.tool.trim": keys(),
      "midi.tool.split": keys(),
      "midi.tool.glue": keys(),
      "midi.tool.velocity": keys(),
      "midi.tool.line": keys(),
      "midi.tool.zoom": keys(),
      "midi.tool.pan": keys(),
      "midi.repeatSelection": keys(),
      "midi.duplicateSelection": keys(),
      "midi.deselectAll": keys("Shift+D"),
      "midi.moveLeft": keys(),
      "midi.moveRight": keys(),
      "midi.selectPreviousNote": keys("Left"),
      "midi.selectNextNote": keys("Right"),
      "midi.moveLeftFine": keys(),
      "midi.moveRightFine": keys(),
      "midi.movePitchUp": platformKeys([], ["Option+Up"], ["Alt+Up"]),
      "midi.movePitchDown": platformKeys([], ["Option+Down"], ["Alt+Down"]),
      "midi.movePitchOctaveUp": platformKeys([], ["Option+Shift+Up"], ["Alt+Shift+Up"]),
      "midi.movePitchOctaveDown": platformKeys([], ["Option+Shift+Down"], ["Alt+Shift+Down"]),
    },
  },
  {
    id: "digital_performer",
    name: "Digital Performer",
    shortName: "Digital Performer",
    description: "Digital Performer wheel behavior with a strict keyboard map: unsourced OpenStudio fallback keys are disabled because DP's published key map is user-assignable; Escape is retained only as an OpenStudio dialog-safety command.",
    nativePlatforms: ["macos", "windows"],
    fallbackPolicy: "strict",
    // DP key commands are broadly customizable. The official material used
    // for this profile documents assignment capacity, not a stable default
    // command table that maps safely onto OpenStudio actions.
    bindings: {
      // OpenStudio app safety only, not a claim about Digital Performer: strict
      // profiles must still leave users a reliable way to dismiss our dialogs.
      "modal.close": keys("Esc"),
      "automation.toggleArrangementView": keys(),
    },
  },
  {
    id: "ardour",
    name: "Ardour",
    shortName: "Ardour",
    description: "Ardour editor tools, split, snap, zoom, and transport conventions.",
    nativePlatforms: ["macos", "windows", "linux"],
    bindings: {
      "automation.toggleArrangementView": keys(),
      "transport.record": keys("Shift+Space"),
      "tools.selectTool": keys("G"),
      "tools.smartTool": keys("3"),
      "tools.splitTool": keys("C"),
      "edit.splitAtCursor": keys("S"),
      // Ardour uses plain arrows for playhead/grid movement and Ctrl/Cmd+Arrow
      // for transient navigation. Clip nudge is on the numeric keypad.
      "edit.nudgeLeft": keys("NumpadSubtract"),
      "edit.nudgeRight": keys("NumpadAdd"),
      "edit.nudgeLeftFine": keys(),
      "edit.nudgeRightFine": keys(),
      "navigate.previousGridLine": keys("Left"),
      "navigate.nextGridLine": keys("Right"),
      "navigate.prevTransient": keys("Ctrl+Left"),
      "navigate.nextTransient": keys("Ctrl+Right"),
      // U selects regions inside the edit range. Alt/Option+1 is Ardour's
      // selected-region mute command.
      "edit.selectClipsInTimeSelection": keys("U"),
      "edit.muteClips": platformKeys([], ["Option+1"], ["Alt+1"], ["Alt+1"]),
      "edit.selectAllTracks": keys(),
      "edit.selectAllClips": keys("Ctrl+A"),
      // Tab adds a mark in the Editor; it is not transient navigation.
      "insert.marker": keys("Tab"),
      "automation.point.selectNext": keys(),
      "automation.point.selectPrevious": keys(),
      "view.toggleSnap": keys("4"),
      "view.zoomIn": keys("="),
      "view.zoomOut": keys("-"),
      "view.zoomToSelection": keys("Z"),
      "transport.rewind": keys("Home", "Enter"),
      "view.toggleVirtualKeyboard": platformKeys([], ["Option+K"], ["Alt+K"], ["Alt+K"]),
      "view.toggleMixer": platformKeys([], ["Option+M"], ["Alt+M"], ["Alt+M"]),
      "file.render": platformKeys([], ["Option+E"], ["Alt+E"], ["Alt+E"]),
      "insert.mediaFile": keys("Ctrl+I"),
      "insert.multipleTracks": keys("Ctrl+Shift+N"),
      "midi.panic": keys("Ctrl+`"),
      "view.setLoopToSelection": keys("]"),
      // F1-F12 load editor views; Ctrl/Cmd+F1-F12 store them.
      "help.contextualHelp": keys(),
      "view.clipProperties": keys(),
      "view.loadScreenset1": keys("F1"),
      "view.loadScreenset2": keys("F2"),
      "view.loadScreenset3": keys("F3"),
      "view.saveScreenset1": keys("Ctrl+F1"),
      "view.saveScreenset2": keys("Ctrl+F2"),
      "view.saveScreenset3": keys("Ctrl+F3"),
      // Delete in Ardour's mixer targets processors, not tracks.
      "track.deleteSelected": keys(),
      // Ardour's MIDI editor uses command operations rather than OpenStudio's
      // persistent letter-tool aliases.
      "midi.closeEditor": keys(),
      "midi.deselectAll": keys("Esc"),
      "midi.tool.draw": keys(),
      "midi.tool.select": keys(),
      "midi.tool.erase": keys(),
      "midi.tool.trim": keys(),
      "midi.tool.split": keys(),
      "midi.tool.glue": keys(),
      "midi.tool.mute": keys(),
      "midi.tool.velocity": keys(),
      "midi.tool.line": keys(),
      "midi.tool.zoom": keys(),
      "midi.tool.pan": keys(),
      "midi.tool.range": keys(),
      "midi.repeatSelection": keys(),
      "midi.moveLeftFine": keys(),
      "midi.moveRightFine": keys(),
      "midi.movePitchOctaveUp": platformKeys([], ["Option+Up"], ["Alt+Up"], ["Alt+Up"]),
      "midi.movePitchOctaveDown": platformKeys([], ["Option+Down"], ["Alt+Down"], ["Alt+Down"]),
      "midi.invertSelection": keys("Ctrl+I"),
    },
  },
  {
    id: "adobe_audition",
    name: "Adobe Audition",
    shortName: "Audition",
    description: "Adobe Audition 26.3+ editor navigation, marker, nudge, and zoom conventions.",
    nativePlatforms: ["macos", "windows"],
    bindings: {
      "automation.toggleArrangementView": keys(),
      "transport.rewind": keys("Home"),
      "insert.marker": keys("M", "NumpadMultiply"),
      "midi.tool.mute": keys(),
      "track.toggleSelectedMute": keys(),
      "edit.nudgeLeft": platformKeys([], ["Option+,"], ["Alt+,"]),
      "edit.nudgeRight": platformKeys([], ["Option+."], ["Alt+."]),
      // Cmd/Ctrl+Arrow moves the CTI to an adjacent marker/clip/selection
      // boundary in Audition; it must never move clips.
      "edit.nudgeLeftFine": keys(),
      "edit.nudgeRightFine": keys(),
      "navigate.previousBoundary": keys("Ctrl+Left"),
      "navigate.nextBoundary": keys("Ctrl+Right"),
      // Ctrl/Cmd+R and Shift+R are Waveform Editor repeat commands. OpenStudio
      // has no equivalent editor mode, so neither is projected globally.
      "transport.record": keys(),
      "insert.regionFromSelection": keys(),
      // Only Audition's exact =/- time-zoom actions are represented. Its other
      // editor tools are not equivalent to OpenStudio's persistent B/X/Y tools.
      "tools.selectTool": keys(),
      "tools.splitTool": keys(),
      "tools.muteTool": keys(),
      "tools.smartTool": keys(),
      "view.zoomIn": keys("="),
      "view.zoomOut": keys("-"),
      "view.verticalZoomIn": platformKeys([], ["Option+="], ["Alt+="]),
      "view.verticalZoomOut": platformKeys([], ["Option+-"], ["Alt+-"]),
    },
  },
  {
    id: "mixcraft",
    name: "Mixcraft",
    shortName: "Mixcraft",
    description: "Mixcraft 10 transport, editing, track, MIDI, and default wheel conventions.",
    nativePlatforms: ["windows"],
    scopeAdditions: {
      "track.toggleSelectedArm": ["timeline"],
      "track.toggleSelectedMute": ["timeline"],
      "track.toggleSelectedSolo": ["timeline"],
    },
    bindings: {
      "automation.toggleArrangementView": keys(),
      "transport.record": keys("R", "Ctrl+R"),
      "transport.loop": keys("L"),
      "transport.metronome": keys("M"),
      "midi.tool.line": keys(),
      "midi.tool.mute": keys(),
      "edit.splitAtCursor": keys("Ctrl+T"),
      "edit.normalizeClips": keys("Ctrl+K"),
      // Ctrl+Q is Crop and Ctrl+D/Ctrl+U move the selected track in Mixcraft.
      // Exact crop/track-order actions are registered separately; never let
      // these chords quit the app or duplicate clips in the interim.
      "file.quit": keys(),
      "edit.duplicateClips": keys(),
      "insert.marker": keys("Ctrl+/"),
      "insert.audioTrack": keys("Ctrl+G"),
      "edit.groupClips": keys(),
      "insert.midiTrack": keys("Ctrl+E"),
      "view.zoomToFit": keys("0"),
      "midi.panic": keys("Ctrl+Shift+M"),
      "view.toggleVirtualKeyboard": keys("Ctrl+Alt+K"),
      "track.toggleSelectedArm": keys("Ctrl+B"),
      "track.toggleSelectedMute": keys("Ctrl+M"),
      "track.toggleSelectedSolo": keys("Ctrl+L"),
      "track.deleteSelected": keys("Ctrl+Shift+D"),
      "track.moveSelectedDown": keys("Ctrl+D"),
      "track.moveSelectedUp": keys("Ctrl+U"),
      "track.toggleSelectedFreeze": keys("Ctrl+F"),
      "options.preferences": keys("Ctrl+Alt+P"),
      "view.toggleMixer": keys(),
      "view.setLoopToSelection": keys(),
      "midi.tool.range": keys(),
      // Shift+M toggles the recording metronome, not Add Named Marker.
      "insert.markerNamed": keys(),
      // Tab/Shift+Tab select adjacent clips (or notes in the MIDI editor), not
      // transients. Exact selection actions are tracked separately.
      "navigate.nextTransient": keys(),
      "navigate.prevTransient": keys(),
      "edit.selectNextClip": keys("Tab"),
      "edit.selectPreviousClip": keys("Shift+Tab"),
      "edit.selectAllTracks": keys(),
      "edit.selectAllClips": keys("Ctrl+A"),
      "edit.deselectAll": keys(),
      // Esc unselects notes; it does not close the MIDI editor. Mixcraft's
      // documented W/E tool map contains only exact Select/Erase equivalents.
      "midi.closeEditor": keys(),
      "midi.deselectAll": keys("Esc"),
      "midi.selectNextNote": keys("Tab"),
      "midi.selectPreviousNote": keys("Shift+Tab"),
      "midi.tool.draw": keys(),
      "midi.tool.select": keys("W"),
      "midi.tool.erase": keys("E"),
      "midi.tool.trim": keys(),
      "midi.tool.split": keys(),
      "midi.tool.glue": keys(),
      "midi.tool.velocity": keys(),
      "midi.tool.zoom": keys(),
      "midi.tool.pan": keys(),
      "midi.repeatSelection": keys(),
      "midi.duplicateSelection": keys(),
      // The official shortcut table and menu disagree about +/- zoom. Do not
      // retain OpenStudio's unrelated Ctrl/Cmd+plus/minus defaults.
      "view.zoomIn": keys(),
      "view.zoomOut": keys(),
    },
  },
  {
    id: "waveform",
    name: "Waveform",
    shortName: "Waveform",
    description: "Strict Waveform 14 quick-start map: only documented split, record, zoom, fit, playback, and wheel commands are enabled; unsourced OpenStudio fallbacks are disabled, except Escape retained solely for OpenStudio dialog safety.",
    nativePlatforms: ["macos", "windows", "linux"],
    fallbackPolicy: "strict",
    bindings: {
      // OpenStudio app safety only, not a source-DAW shortcut claim.
      "modal.close": keys("Esc"),
      "automation.toggleArrangementView": keys(),
      "transport.play": keys("Space"),
      "transport.record": keys("R"),
      "track.toggleSelectedArm": keys(),
      "midi.tool.range": keys(),
      "edit.splitAtCursor": keys("/"),
      "view.zoomIn": keys("Up"),
      "view.zoomOut": keys("Down"),
      "view.zoomToFit": keys("F8"),
    },
  },
  {
    id: "renoise",
    name: "Renoise",
    shortName: "Renoise",
    description: "Strict Renoise tracker map: only documented portable commands are enabled; focus-dependent tracker keys and unsourced OpenStudio fallbacks are disabled, except Escape retained solely inside OpenStudio dialogs for app safety.",
    nativePlatforms: ["macos", "windows", "linux"],
    fallbackPolicy: "strict",
    bindings: {
      // This modal-scoped safety binding does not project Renoise's tracker
      // Edit Mode semantics into OpenStudio's editors.
      "modal.close": keys("Esc"),
      "automation.toggleArrangementView": keys(),
      "transport.play": keys("Space"),
      "edit.undo": keys("Ctrl+Z"),
      "edit.redo": keys("Ctrl+Y"),
      "edit.cut": keys("Ctrl+X"),
      "edit.copy": keys("Ctrl+C"),
      "edit.paste": keys("Ctrl+V"),
      // Renoise Esc toggles tracker Edit Mode. OpenStudio Piano Roll Step Input
      // is not the same state, so both Esc actions remain unassigned.
      "midi.closeEditor": keys(),
      "midi.toggleStepInput": keys(),
      "transport.record": keys(),
      "track.toggleSelectedArm": keys(),
      "midi.tool.range": keys(),
      "tools.selectTool": keys(),
      "tools.splitTool": keys(),
      "tools.muteTool": keys(),
      "tools.smartTool": keys(),
      "edit.muteClips": keys(),
      "edit.ungroupClips": keys(),
      "insert.marker": keys(),
      "edit.editPitch": keys(),
    },
  },
] as const;

const PROFILE_BY_ID = new Map<KeyboardShortcutProfileId, KeyboardShortcutProfile>(
  KEYBOARD_SHORTCUT_PROFILES.map((profile) => [profile.id, profile]),
);

export function isKeyboardShortcutProfileId(value: unknown): value is KeyboardShortcutProfileId {
  return typeof value === "string"
    && (KEYBOARD_SHORTCUT_PROFILE_IDS as readonly string[]).includes(value);
}

export function getKeyboardShortcutProfile(value: unknown): KeyboardShortcutProfile {
  const id = isKeyboardShortcutProfileId(value) ? value : "openstudio";
  return PROFILE_BY_ID.get(id) ?? KEYBOARD_SHORTCUT_PROFILES[0];
}

export interface KeyboardShortcutProfilePresentation {
  profile: KeyboardShortcutProfile;
  isNativeSourcePlatform: boolean;
  optionLabel: string;
  policyLabel: string;
  availabilityLabel: string;
  description: string;
}

function shortcutPlatformLabel(platform: ShortcutPlatform): string {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "linux") return "Linux";
  return "this platform";
}

export function getKeyboardShortcutProfilePresentation(
  value: unknown,
  platform: ShortcutPlatform,
): KeyboardShortcutProfilePresentation {
  const profile = getKeyboardShortcutProfile(value);
  const platformName = shortcutPlatformLabel(platform);
  const isNativeSourcePlatform = profile.nativePlatforms.includes(platform);
  const availabilityLabel = isNativeSourcePlatform
    ? `Native source platform: ${platformName}`
    : `Cross-platform emulation on ${platformName}; the source DAW has no native ${platformName} version`;
  const policyLabel = profile.fallbackPolicy === "strict"
    ? "Strict profile: omitted and unsourced commands stay unassigned"
    : "OpenStudio fallback: omitted commands keep their OpenStudio default; explicit unassignments stay unassigned";
  return {
    profile,
    isNativeSourcePlatform,
    optionLabel: isNativeSourcePlatform
      ? profile.name
      : `${profile.name} (cross-platform emulation)`,
    policyLabel,
    availabilityLabel,
    description: `${profile.description} ${availabilityLabel}.`,
  };
}

function isPlatformShortcutBindings(
  value: ProfileActionBindings,
): value is PlatformShortcutBindings {
  return !Array.isArray(value);
}

export function getProfileActionBindings(
  profileId: unknown,
  actionId: string,
  platform: ShortcutPlatform,
): readonly string[] | undefined {
  const profile = getKeyboardShortcutProfile(profileId);
  const configured = profile.bindings[actionId];
  if (!configured) return profile.fallbackPolicy === "strict" ? [] : undefined;
  if (!isPlatformShortcutBindings(configured)) return configured;

  const common = configured.common ?? [];
  const platformBindings = configured[platform]
    ?? (platform === "other" ? configured.windows : undefined)
    ?? [];
  return [...common, ...platformBindings];
}

export function getProfileActionScopeAdditions(
  profileId: unknown,
  actionId: string,
): readonly ProfileShortcutScope[] {
  return getKeyboardShortcutProfile(profileId).scopeAdditions?.[actionId] ?? [];
}
