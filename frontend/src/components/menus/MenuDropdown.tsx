import { useState, useRef, useEffect, useLayoutEffect, useId, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { Button } from "../ui";
import { useTransientOverlayShortcutScope } from "../../utils/modalShortcutScope";
import { matchesActionShortcut } from "../../utils/globalShortcutDispatcher";

interface MenuItemProps {
  label: string; shortcut?: string; onClick?: () => void; disabled?: boolean;
  dividerAfter?: boolean; submenu?: MenuItemProps[]; checked?: boolean;
}
interface MenuDropdownProps { label: string; items: MenuItemProps[]; className?: string }

function MenuList({ items, anchor, label, owner, nested = false, close, back, autoFocus = false }: {
  items: MenuItemProps[]; anchor: HTMLElement; label: string; owner: string;
  nested?: boolean; close: () => void; back: () => void; autoFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [child, setChild] = useState<{ index: number; anchor: HTMLElement; focus: boolean } | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 32 });
  useLayoutEffect(() => {
    const place = () => {
      const box = anchor.getBoundingClientRect();
      const menu = ref.current!;
      const width = menu.offsetWidth;
      let left = nested ? box.right : box.left;
      if (left + width > window.innerWidth - 8) left = nested ? box.left - width : window.innerWidth - width - 8;
      setPosition({ left: Math.max(8, left), top: Math.max(8, Math.min(nested ? box.top : box.bottom, window.innerHeight - menu.offsetHeight - 8)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    if (autoFocus) ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor, nested, autoFocus]);
  return createPortal(<div ref={ref} role="menu" aria-label={`${label} menu`} data-menu-owner={owner}
    className="fixed left-[var(--menu-left)] top-[var(--menu-top)] z-[10000] flex max-h-[calc(100dvh-16px)] min-w-48 max-w-[calc(100vw-16px)] flex-col overflow-y-auto rounded border border-daw-border bg-daw-panel py-1 shadow-xl"
    style={{ "--menu-left": `${position.left}px`, "--menu-top": `${position.top}px` } as CSSProperties}
    onKeyDown={event => {
      if (event.target instanceof HTMLElement && !ref.current?.contains(event.target)) return;
      const rows = [...ref.current!.querySelectorAll<HTMLButtonElement>(':scope > div > button:not([disabled])')];
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        rows[event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
      } else if (event.key === "ArrowLeft" || (event.key === "Escape" && matchesActionShortcut(event.nativeEvent, "modal.close"))) {
        event.preventDefault(); event.stopPropagation(); back(); anchor.focus();
      }
    }}>
    {items.map((item, index) => <div key={`${index}:${item.label}`}>
      <button type="button" role="menuitem" aria-label={item.label} disabled={item.disabled} aria-disabled={item.disabled || undefined}
        aria-haspopup={item.submenu ? "menu" : undefined} aria-expanded={item.submenu ? child?.index === index : undefined}
        className="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-sm text-daw-text hover:bg-daw-selection focus-visible:bg-daw-selection focus-visible:outline-none disabled:cursor-not-allowed disabled:text-daw-text-muted"
        onMouseEnter={event => setChild(item.submenu && !item.disabled ? { index, anchor: event.currentTarget, focus: false } : null)}
        onKeyDown={event => { if (event.key === "ArrowRight" && item.submenu) { event.preventDefault(); event.stopPropagation(); setChild({ index, anchor: event.currentTarget, focus: true }); } }}
        onClick={event => {
          if (item.submenu) setChild({ index, anchor: event.currentTarget, focus: event.detail === 0 });
          else { close(); item.onClick?.(); }
        }}>
        <span className="flex min-w-0 items-center gap-2"><span className="w-4 shrink-0">{item.checked && <Check size={14} />}</span><span>{item.label}</span></span>
        <span className="flex shrink-0 items-center gap-2">{item.shortcut && <span className="text-xs text-daw-text-muted">{item.shortcut}</span>}{item.submenu && <ChevronRight size={14} />}</span>
      </button>
      {item.dividerAfter && <div role="separator" className="my-1 border-t border-daw-border" />}
    </div>)}
    {child && items[child.index]?.submenu && <MenuList items={items[child.index].submenu!} anchor={child.anchor} label={items[child.index].label} owner={owner} nested close={close} back={() => setChild(null)} autoFocus={child.focus} />}
  </div>, document.body);
}

export function MenuDropdown({ label, items, className = "" }: MenuDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const owner = useId();
  const close = () => setIsOpen(false);
  useTransientOverlayShortcutScope(isOpen, close);
  useEffect(() => {
    if (!isOpen) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!trigger.current?.contains(target) && target.closest('[data-menu-owner]')?.getAttribute('data-menu-owner') !== owner) close();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [isOpen, owner]);
  return <div className={className}>
    <Button ref={trigger} variant="ghost" size="sm" active={isOpen} onClick={event => { setKeyboardOpen(event.detail === 0); setIsOpen(!isOpen); }}
      onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setKeyboardOpen(true); setIsOpen(true); } }}
      className="rounded-none px-3 py-1" role="menuitem" aria-haspopup="menu" aria-expanded={isOpen} aria-label={`${label} menu`}>{label}</Button>
    {isOpen && trigger.current && <MenuList items={items} anchor={trigger.current} label={label} owner={owner} close={close} back={close} autoFocus={keyboardOpen} />}
  </div>;
}
export type { MenuItemProps, MenuDropdownProps };
