import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  divider?: boolean;
  submenu?: MenuItem[];
  onClick?: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [submenuOpen, setSubmenuOpen] = useState<number | null>(null);
  const [adjustedPos, setAdjustedPos] = useState({ x, y });

  // Adjust position to stay within viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let newX = x;
      let newY = y;

      if (x + rect.width > viewportWidth) {
        newX = viewportWidth - rect.width - 8;
      }
      if (y + rect.height > viewportHeight) {
        newY = viewportHeight - rect.height - 8;
      }

      setAdjustedPos({ x: Math.max(8, newX), y: Math.max(8, newY) });
    }
  }, [x, y]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  const handleItemClick = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.submenu) return; // Don't close for submenu items
    item.onClick?.();
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[180px] py-1 bg-neutral-800 border border-neutral-600 rounded-md shadow-xl"
      style={{
        left: adjustedPos.x,
        top: adjustedPos.y,
      }}
    >
      {items.map((item, index) => {
        if (item.divider) {
          return (
            <div key={index} className="my-1 border-t border-neutral-600" />
          );
        }

        return (
          <div
            key={index}
            className={`
              relative px-3 py-1.5 flex items-center justify-between gap-4 cursor-pointer
              ${item.disabled ? "text-neutral-500 cursor-not-allowed" : "text-neutral-200 hover:bg-neutral-700"}
            `}
            onClick={() => handleItemClick(item)}
            onMouseEnter={() => item.submenu && setSubmenuOpen(index)}
            onMouseLeave={() => item.submenu && setSubmenuOpen(null)}
          >
            <div className="flex items-center gap-2">
              {item.icon && <span className="w-4 h-4">{item.icon}</span>}
              <span className="text-sm">{item.label}</span>
            </div>
            <div className="flex items-center gap-2">
              {item.shortcut && (
                <span className="text-xs text-neutral-500">
                  {item.shortcut}
                </span>
              )}
              {item.submenu && <ChevronRight size={14} />}
            </div>

            {/* Submenu */}
            {item.submenu && submenuOpen === index && (
              <div className="absolute left-full top-0 ml-1 min-w-[160px] py-1 bg-neutral-800 border border-neutral-600 rounded-md shadow-xl">
                {item.submenu.map((subItem, subIndex) => (
                  <div
                    key={subIndex}
                    className={`
                      px-3 py-1.5 text-sm cursor-pointer
                      ${subItem.disabled ? "text-neutral-500 cursor-not-allowed" : "text-neutral-200 hover:bg-neutral-700"}
                    `}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!subItem.disabled) {
                        subItem.onClick?.();
                        onClose();
                      }
                    }}
                  >
                    {subItem.label}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

// Hook to manage context menu state
export function useContextMenu() {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);

  const showContextMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const hideContextMenu = () => setContextMenu(null);

  const ContextMenuComponent = contextMenu ? (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      items={contextMenu.items}
      onClose={hideContextMenu}
    />
  ) : null;

  return { showContextMenu, hideContextMenu, ContextMenuComponent };
}
