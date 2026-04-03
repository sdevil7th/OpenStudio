import { useEffect, useRef, useState } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button } from "./ui";

interface ColorPickerProps {
  currentColor: string;
  onColorChange: (color: string) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

// 16 predefined DAW colors — users can assign same color to multiple tracks for grouping
export const TRACK_COLORS = [
  { name: "Cyan", value: "#00bcd4" },
  { name: "Blue", value: "#2196f3" },
  { name: "Indigo", value: "#3f51b5" },
  { name: "Purple", value: "#9c27b0" },
  { name: "Pink", value: "#e91e63" },
  { name: "Red", value: "#f44336" },
  { name: "Deep Orange", value: "#ff5722" },
  { name: "Orange", value: "#ff9800" },
  { name: "Amber", value: "#ffc107" },
  { name: "Yellow", value: "#ffeb3b" },
  { name: "Lime", value: "#cddc39" },
  { name: "Green", value: "#4caf50" },
  { name: "Teal", value: "#009688" },
  { name: "Brown", value: "#795548" },
  { name: "Blue Grey", value: "#607d8b" },
  { name: "Grey", value: "#9e9e9e" },
];

export function ColorPicker({
  currentColor,
  onColorChange,
  onClose,
  anchorRef,
}: ColorPickerProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const { recentColors, addRecentColor } = useDAWStore(useShallow((s) => ({
    recentColors: s.recentColors,
    addRecentColor: s.addRecentColor,
  })));

  const handleColorSelect = (color: string) => {
    addRecentColor(color);
    onColorChange(color);
  };

  // Position relative to anchor element
  useEffect(() => {
    if (anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      let top = rect.top;
      let left = rect.right + 4;

      // Ensure popup doesn't go below viewport
      const popupHeight = 260; // approximate height with recent colors
      if (top + popupHeight > window.innerHeight) {
        top = window.innerHeight - popupHeight - 8;
      }
      if (top < 8) top = 8;

      setPosition({ top, left });
    }
  }, [anchorRef]);

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

  const style: React.CSSProperties = position
    ? { position: "fixed", top: position.top, left: position.left, zIndex: 9999 }
    : { position: "absolute", left: 4, top: 0, zIndex: 50 };

  return (
    <div
      ref={popupRef}
      className="bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-2"
      style={style}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-xs text-neutral-400 mb-2 px-1">Track Color</div>
      <div className="grid grid-cols-4 gap-1.5">
        {TRACK_COLORS.map((color) => (
          <Button
            key={color.value}
            variant="ghost"
            onClick={() => handleColorSelect(color.value)}
            className={`w-7 h-7 !p-0 rounded-md transition-all hover:scale-110 hover:ring-2 hover:ring-white/50 ${
              currentColor === color.value ? "ring-2 ring-white scale-110" : ""
            }`}
            style={{ backgroundColor: color.value }}
            title={color.name}
          />
        ))}
      </div>

      {/* Recent Colors */}
      {recentColors.length > 0 && (
        <>
          <div className="text-[10px] text-neutral-500 mt-2.5 mb-1.5 px-1 uppercase tracking-wider">
            Recent
          </div>
          <div className="flex gap-1.5 px-0.5">
            {recentColors.map((color, i) => (
              <button
                key={`${color}-${i}`}
                onClick={() => handleColorSelect(color)}
                className={`w-5 h-5 rounded-sm border transition-all hover:scale-110 hover:ring-1 hover:ring-white/50 ${
                  currentColor === color ? "ring-1 ring-white scale-110 border-white/50" : "border-neutral-600"
                }`}
                style={{ backgroundColor: color }}
                title={color}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
