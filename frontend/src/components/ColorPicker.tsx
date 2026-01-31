import { useEffect, useRef } from "react";
import { Button } from "./ui";

interface ColorPickerProps {
  currentColor: string;
  onColorChange: (color: string) => void;
  onClose: () => void;
}

// Predefined track colors - users can assign same color to multiple tracks for grouping
export const TRACK_COLORS = [
  { name: "Cyan", value: "#00bcd4" },
  { name: "Blue", value: "#2196f3" },
  { name: "Indigo", value: "#3f51b5" },
  { name: "Purple", value: "#9c27b0" },
  { name: "Pink", value: "#e91e63" },
  { name: "Red", value: "#f44336" },
  { name: "Orange", value: "#ff9800" },
  { name: "Yellow", value: "#ffeb3b" },
  { name: "Lime", value: "#cddc39" },
  { name: "Green", value: "#4caf50" },
  { name: "Teal", value: "#009688" },
  { name: "Brown", value: "#795548" },
];

export function ColorPicker({
  currentColor,
  onColorChange,
  onClose,
}: ColorPickerProps) {
  const popupRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Delay adding listener to avoid immediate close
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      ref={popupRef}
      className="absolute left-4 top-0 z-50 bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-2"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-xs text-neutral-400 mb-2 px-1">Track Color</div>
      <div className="grid grid-cols-4 gap-1.5">
        {TRACK_COLORS.map((color) => (
          <Button
            key={color.value}
            variant="ghost"
            onClick={() => onColorChange(color.value)}
            className={`w-7 h-7 !p-0 rounded-md transition-all hover:scale-110 hover:ring-2 hover:ring-white/50 ${
              currentColor === color.value ? "ring-2 ring-white scale-110" : ""
            }`}
            style={{ backgroundColor: color.value }}
            title={color.name}
          />
        ))}
      </div>
    </div>
  );
}
