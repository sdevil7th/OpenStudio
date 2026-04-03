import React from "react";

export interface IconProps {
  size?: number;
  className?: string;
}

/**
 * Metronome icon - based on custom SVG asset
 * Uses currentColor so it inherits text color from parent
 */
export function MetronomeIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="currentColor"
      className={className}
    >
      <path d="M16,21c0.3,0,0.6-0.1,0.8-0.4l13-17c0.3-0.4,0.3-1.1-0.2-1.4c-0.4-0.3-1.1-0.3-1.4,0.2l-5.7,7.5l-1-4.8c-0.4-1.8-2-3.1-3.8-3.1h-3.4c-1.8,0-3.4,1.2-3.8,3L5.8,25.5c-0.3,1.1,0,2.2,0.7,3.1C7.2,29.5,8.2,30,9.3,30h13.3c1.1,0,2.2-0.5,2.9-1.4c0.7-0.9,0.9-2,0.7-3.1l-2.5-9.7c-0.1-0.5-0.7-0.9-1.2-0.7c-0.5,0.1-0.9,0.7-0.7,1.2l1.5,5.8H8.6l3.8-16.5c0.2-0.9,1-1.5,1.8-1.5h3.4c0.9,0,1.7,0.6,1.8,1.5l1.4,6.5l-5.6,7.4c-0.3,0.4-0.3,1.1,0.2,1.4C15.6,20.9,15.8,21,16,21z" />
      <path d="M15,8h2c0.6,0,1-0.4,1-1s-0.4-1-1-1h-2c-0.6,0-1,0.4-1,1S14.4,8,15,8z" />
      <path d="M15,11h2c0.6,0,1-0.4,1-1s-0.4-1-1-1h-2c-0.6,0-1,0.4-1,1S14.4,11,15,11z" />
      <path d="M15,14h2c0.6,0,1-0.4,1-1s-0.4-1-1-1h-2c-0.6,0-1,0.4-1,1S14.4,14,15,14z" />
    </svg>
  );
}

/**
 * Piano/keyboard icon - simplified outline for UI use
 * Uses currentColor for stroke so it inherits text color
 */
export function PianoIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Outer frame */}
      <rect x="2" y="4" width="20" height="16" rx="1.5" />
      {/* White key dividers */}
      <line x1="6.4" y1="4" x2="6.4" y2="20" />
      <line x1="10.8" y1="4" x2="10.8" y2="20" />
      <line x1="15.2" y1="4" x2="15.2" y2="20" />
      <line x1="19.6" y1="4" x2="19.6" y2="20" />
      {/* Black keys */}
      <rect x="5" y="4" width="2.8" height="9.5" rx="0.5" fill="currentColor" stroke="none" />
      <rect x="9.4" y="4" width="2.8" height="9.5" rx="0.5" fill="currentColor" stroke="none" />
      <rect x="16.6" y="4" width="2.8" height="9.5" rx="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ── Track Icons ─────────────────────────────────────────────────────────────

export function MicrophoneIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="17" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}

export function GuitarIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20 2l-2 2m0 0l-2.5 2.5L18 9l2.5-2.5L23 4l-3-2z" />
      <path d="M15.5 6.5l-5.5 5.5a4.5 4.5 0 1 0 2 2l5.5-5.5" />
      <circle cx="9" cy="15" r="1" fill="currentColor" />
    </svg>
  );
}

export function DrumsIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <ellipse cx="12" cy="14" rx="9" ry="4" />
      <path d="M3 14v2c0 2.2 4 4 9 4s9-1.8 9-4v-2" />
      <path d="M3 10c0-2.2 4-4 9-4s9 1.8 9 4v4" />
      <line x1="6" y1="4" x2="10" y2="10" />
      <line x1="18" y1="4" x2="14" y2="10" />
    </svg>
  );
}

export function KeysIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2" y="6" width="20" height="12" rx="1" />
      <line x1="6" y1="6" x2="6" y2="18" />
      <line x1="10" y1="6" x2="10" y2="18" />
      <line x1="14" y1="6" x2="14" y2="18" />
      <line x1="18" y1="6" x2="18" y2="18" />
      <rect x="4.5" y="6" width="2" height="7" rx="0.3" fill="currentColor" stroke="none" />
      <rect x="8.5" y="6" width="2" height="7" rx="0.3" fill="currentColor" stroke="none" />
      <rect x="15" y="6" width="2" height="7" rx="0.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BusIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 8h16v8H4z" />
      <path d="M8 8V5h8v3" />
      <line x1="8" y1="8" x2="8" y2="16" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="16" y1="8" x2="16" y2="16" />
      <line x1="4" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function MasterIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="4" height="16" rx="1" />
      <rect x="10" y="7" width="4" height="13" rx="1" />
      <rect x="17" y="2" width="4" height="18" rx="1" />
      <line x1="3" y1="22" x2="21" y2="22" />
    </svg>
  );
}

export function MIDIIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="8" cy="10" r="1" fill="currentColor" />
      <circle cx="16" cy="10" r="1" fill="currentColor" />
      <circle cx="8" cy="14" r="1" fill="currentColor" />
      <circle cx="16" cy="14" r="1" fill="currentColor" />
      <circle cx="12" cy="14" r="1" fill="currentColor" />
    </svg>
  );
}

export function FolderIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** All available track icons, keyed by icon ID */
export const TRACK_ICONS: Record<string, React.FC<IconProps>> = {
  microphone: MicrophoneIcon,
  guitar: GuitarIcon,
  drums: DrumsIcon,
  keys: KeysIcon,
  bus: BusIcon,
  master: MasterIcon,
  midi: MIDIIcon,
  folder: FolderIcon,
  piano: PianoIcon,
};

/** Icon ID labels for UI display */
export const TRACK_ICON_LABELS: Record<string, string> = {
  microphone: "Microphone",
  guitar: "Guitar",
  drums: "Drums",
  keys: "Keys",
  bus: "Bus",
  master: "Master",
  midi: "MIDI",
  folder: "Folder",
  piano: "Piano",
};
