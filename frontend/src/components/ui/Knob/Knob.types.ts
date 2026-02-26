export type KnobSize = "sm" | "md";
export type KnobVariant = "default" | "volume" | "pan";

export interface KnobProps {
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Current value */
  value: number;
  /** Default value for Ctrl+Click reset */
  defaultValue: number;
  /** Change handler — called during drag */
  onChange: (value: number) => void;
  /** Called on drag start (pointer down) — for undo snapshot */
  onBeginEdit?: () => void;
  /** Called on drag end (pointer up) — for undo commit */
  onCommitEdit?: () => void;
  /** Format value for tooltip */
  formatValue?: (value: number) => string;
  /** Visual variant */
  variant?: KnobVariant;
  /** Diameter size */
  size?: KnobSize;
  /** Drag sensitivity — pixels of vertical movement for full range */
  sensitivity?: number;
  /** Accessible label */
  label?: string;
  /** Additional CSS class on wrapper */
  className?: string;
  /** Disabled state */
  disabled?: boolean;
  /**
   * For bipolar fill (e.g. pan): the value at which the arc fill originates.
   * If undefined, fill starts from min (unipolar).
   */
  bipolarCenter?: number;
}

export const knobSizeMap: Record<KnobSize, number> = {
  sm: 24,
  md: 30,
};
