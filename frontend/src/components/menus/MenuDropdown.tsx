import { useState, useRef, useEffect } from "react";
import { Button } from "../ui";

interface MenuItemProps {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  dividerAfter?: boolean;
  submenu?: MenuItemProps[];
  checked?: boolean;
}

interface MenuDropdownProps {
  label: string;
  items: MenuItemProps[];
  className?: string;
}

/**
 * Reusable Menu Dropdown Component
 * Supports keyboard shortcuts display, submenus, dividers, and checkmarks
 */
export function MenuDropdown({
  label,
  items,
  className = "",
}: MenuDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setActiveSubmenu(null);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setActiveSubmenu(null);
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen]);

  const handleItemClick = (item: MenuItemProps, index: number) => {
    if (item.disabled) return;

    if (item.submenu) {
      setActiveSubmenu(activeSubmenu === index ? null : index);
    } else {
      item.onClick?.();
      setIsOpen(false);
      setActiveSubmenu(null);
    }
  };

  const renderMenuItem = (item: MenuItemProps, index: number) => (
    <div key={index}>
      <div
        className={`
          flex items-center justify-between px-3 py-1.5 text-sm cursor-pointer
          ${
            item.disabled
              ? "text-daw-text-muted cursor-not-allowed"
              : "text-daw-text hover:bg-daw-selection"
          }
          ${activeSubmenu === index ? "bg-daw-selection" : ""}
        `}
        onClick={() => handleItemClick(item, index)}
        onMouseEnter={() => item.submenu && setActiveSubmenu(index)}
      >
        <div className="flex items-center gap-2">
          {item.checked !== undefined && (
            <span className="w-4 text-center">{item.checked ? "✓" : ""}</span>
          )}
          <span>{item.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {item.shortcut && (
            <span className="text-xs text-daw-text-muted ml-4">
              {item.shortcut}
            </span>
          )}
          {item.submenu && <span className="text-xs">▶</span>}
        </div>
      </div>

      {/* Submenu */}
      {item.submenu && activeSubmenu === index && (
        <div className="absolute left-full top-0 ml-0 bg-daw-panel border border-daw-border rounded shadow-lg min-w-40 py-1">
          {item.submenu.map((subItem, subIndex) => (
            <div
              key={subIndex}
              className={`
                flex items-center justify-between px-3 py-1.5 text-sm cursor-pointer
                ${
                  subItem.disabled
                    ? "text-daw-text-muted cursor-not-allowed"
                    : "text-daw-text hover:bg-daw-selection"
                }
              `}
              onClick={() => {
                if (!subItem.disabled) {
                  subItem.onClick?.();
                  setIsOpen(false);
                  setActiveSubmenu(null);
                }
              }}
            >
              <span>{subItem.label}</span>
              {subItem.shortcut && (
                <span className="text-xs text-daw-text-muted ml-4">
                  {subItem.shortcut}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {item.dividerAfter && <div className="border-t border-daw-border my-1" />}
    </div>
  );

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      <Button
        variant="ghost"
        size="sm"
        active={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className="px-3 py-1 rounded-none"
      >
        {label}
      </Button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-0.5 bg-daw-panel border border-daw-border rounded shadow-lg min-w-48 py-1 z-50">
          {items.map((item, index) => (
            <div key={index} className="relative">
              {renderMenuItem(item, index)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export type { MenuItemProps, MenuDropdownProps };
