interface IconProps {
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
