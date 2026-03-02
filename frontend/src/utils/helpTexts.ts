/**
 * Contextual help texts for F1 help system (Sprint 18.17)
 * Maps element identifiers to help descriptions.
 */

export interface HelpEntry {
  title: string;
  description: string;
  shortcut?: string;
}

const helpTexts: Record<string, HelpEntry> = {
  // Timeline
  "timeline": {
    title: "Timeline",
    description: "The main workspace for arranging audio and MIDI clips. Drag clips to reposition them, use the scroll wheel to zoom, and right-click for context menu options.",
    shortcut: "Scroll: Navigate | Ctrl+Scroll: Zoom | B: Split Tool",
  },
  "timeline.ruler": {
    title: "Time Ruler",
    description: "Shows the time position in bars/beats or seconds. Click to set the playhead position. Drag to create a time selection.",
  },
  "timeline.clip": {
    title: "Audio/MIDI Clip",
    description: "A region of audio or MIDI data. Drag edges to trim, drag the body to move. Use S to split at playhead, U to toggle mute.",
    shortcut: "S: Split | U: Mute | F2: Properties | Delete: Remove",
  },

  // Transport
  "transport": {
    title: "Transport Bar",
    description: "Controls playback, recording, and time display. Toggle between time formats by clicking the time display.",
    shortcut: "Space: Play/Pause | Ctrl+R: Record | L: Toggle Loop",
  },
  "transport.tempo": {
    title: "Tempo",
    description: "Project tempo in BPM. Double-click to edit. Use T for tap tempo.",
    shortcut: "T: Tap Tempo",
  },
  "transport.timeSig": {
    title: "Time Signature",
    description: "Project time signature (e.g., 4/4). Click to change.",
  },

  // Mixer
  "mixer": {
    title: "Mixer Panel",
    description: "Channel strip mixer with volume faders, pan knobs, solo/mute buttons, and FX chain access for each track.",
    shortcut: "Ctrl+M: Toggle Mixer",
  },
  "mixer.fader": {
    title: "Volume Fader",
    description: "Adjust track volume. Double-click to reset to 0dB. Drag for continuous adjustment.",
  },
  "mixer.pan": {
    title: "Pan Knob",
    description: "Adjust stereo panning. Double-click to center. Left = -100%, Right = +100%.",
  },
  "mixer.solo": {
    title: "Solo Button",
    description: "Solo this track (mute all others). Ctrl+click to exclusive solo.",
  },
  "mixer.mute": {
    title: "Mute Button",
    description: "Mute this track output.",
  },

  // Track Header
  "track.header": {
    title: "Track Header",
    description: "Shows track name, record arm, solo, mute, and input selector. Right-click for more options.",
  },
  "track.arm": {
    title: "Record Arm",
    description: "Arm this track for recording. When armed, the track will capture audio/MIDI input during recording.",
    shortcut: "Ctrl+R: Start Recording",
  },
  "track.input": {
    title: "Input Selector",
    description: "Choose which hardware input feeds this track for recording and monitoring.",
  },

  // FX Chain
  "fx.chain": {
    title: "FX Chain",
    description: "Plugin effects chain. Drag to reorder, click bypass button to bypass individual effects. Input FX are pre-recording, Track FX are post-recording.",
  },
  "fx.browser": {
    title: "Plugin Browser",
    description: "Browse and add VST3/S13FX plugins. Use the search bar and category filter to find plugins. Click 'Scan' to detect new plugins.",
  },

  // Piano Roll
  "pianoroll": {
    title: "Piano Roll",
    description: "MIDI note editor. Click to add notes, drag to move or resize. Use the velocity lane at the bottom to adjust note velocities.",
    shortcut: "Ctrl+A: Select All | Delete: Remove Notes | Ctrl+D: Duplicate",
  },

  // Toolbar
  "toolbar.snap": {
    title: "Snap to Grid",
    description: "When enabled, clips and edits snap to the nearest grid position. Click the dropdown to change grid size.",
  },
  "toolbar.ripple": {
    title: "Ripple Editing",
    description: "When enabled, deleting or moving clips shifts subsequent clips to fill the gap. Modes: Off, Per Track, All Tracks.",
  },

  // Metering
  "meter.peak": {
    title: "Peak Meter",
    description: "Shows the peak audio level. Green = safe, Yellow = caution, Red = clipping. Click to reset peak hold.",
  },
  "meter.loudness": {
    title: "Loudness Meter (LUFS)",
    description: "Measures perceived loudness in LUFS (Loudness Units Full Scale). Target: -14 LUFS for streaming, -23 LUFS for broadcast.",
  },

  // Settings
  "settings.audio": {
    title: "Audio Settings",
    description: "Configure audio driver, sample rate, buffer size, and I/O routing.",
  },
  "settings.preferences": {
    title: "Preferences",
    description: "Application preferences for editing behavior, display options, and backup settings.",
    shortcut: "Ctrl+,",
  },
};

/**
 * Get help text for a given element identifier.
 * Returns undefined if no help is available.
 */
export function getHelpText(elementId: string): HelpEntry | undefined {
  return helpTexts[elementId];
}

/**
 * Get all help entries, useful for building a full help index.
 */
export function getAllHelpTexts(): Record<string, HelpEntry> {
  return { ...helpTexts };
}
