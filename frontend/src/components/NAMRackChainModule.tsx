import "./NAMRackChainModule.css";
import { type DragEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, GripVertical, Plus, Power, Star } from "lucide-react";

export function RackModule({
  icon,
  label,
  caption,
  active,
  favorite = false,
  selected,
  onClick,
  power,
  draggable = false,
  dragging = false,
  dropTarget = false,
  dropAllowed = false,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  canMovePrevious = false,
  canMoveNext = false,
  onMovePrevious,
  onMoveNext,
  extraAction,
  planned = false,
}: {
  icon: ReactNode;
  label: string;
  caption: string;
  active: boolean;
  favorite?: boolean;
  selected: boolean;
  onClick: () => void;
  power?: {
    active: boolean;
    disabled?: boolean;
    title: string;
    onToggle: () => void;
  };
  draggable?: boolean;
  dragging?: boolean;
  dropTarget?: boolean;
  dropAllowed?: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLElement>) => void;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
  canMovePrevious?: boolean;
  canMoveNext?: boolean;
  onMovePrevious?: () => void;
  onMoveNext?: () => void;
  extraAction?: {
    title: string;
    onClick: () => void;
    icon?: ReactNode;
  };
  planned?: boolean;
}) {
  return (
    <article
      className="nam-chain-module"
      data-active={active}
      data-favorite={favorite}
      data-selected={selected}
      data-planned={planned}
      data-dragging={dragging}
      data-drop-target={dropTarget}
      data-drop-allowed={dropAllowed}
      draggable={draggable}
      onDragStart={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button")) {
          event.preventDefault();
          return;
        }
        onDragStart?.(event);
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onClick}
      title={planned ? `${label} is planned for the full DSP chain` : label}
    >
      {draggable && (
        <span
          className="nam-chain-grip"
          onClick={(event) => event.stopPropagation()}
          title={`Drag ${label} slot from anywhere on the card`}
          aria-label={`${label} slot can be dragged from anywhere on the card`}
        >
          <GripVertical size={13} />
        </span>
      )}
      <button
        type="button"
        className="nam-chain-module-main"
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        <span className="nam-chain-icon">{icon}</span>
        <span>
          <strong>{label}</strong>
          <small>{caption}</small>
        </span>
      </button>
      {favorite && (
        <span className="nam-chain-favorite" title={`${label} is a favorite slot`} aria-hidden="true">
          <Star size={10} />
        </span>
      )}
      <div className="nam-chain-slot-actions" aria-label={`${label} slot actions`}>
        <button
          type="button"
          disabled={!canMovePrevious}
          onMouseDown={(event) => {
            if (event.button !== 0 || !canMovePrevious) return;
            event.preventDefault();
            event.stopPropagation();
            onMovePrevious?.();
          }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if ((event.key === "Enter" || event.key === " ") && canMovePrevious) {
              event.preventDefault();
              onMovePrevious?.();
            }
          }}
          title={`Move ${label} left`}
          aria-label={`Move ${label} left`}
        >
          <ArrowLeft size={11} />
        </button>
        <button
          type="button"
          disabled={!canMoveNext}
          onMouseDown={(event) => {
            if (event.button !== 0 || !canMoveNext) return;
            event.preventDefault();
            event.stopPropagation();
            onMoveNext?.();
          }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if ((event.key === "Enter" || event.key === " ") && canMoveNext) {
              event.preventDefault();
              onMoveNext?.();
            }
          }}
          title={`Move ${label} right`}
          aria-label={`Move ${label} right`}
        >
          <ArrowRight size={11} />
        </button>
        {extraAction && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              extraAction.onClick();
            }}
            title={extraAction.title}
            aria-label={extraAction.title}
          >
            {extraAction.icon ?? <Plus size={11} />}
          </button>
        )}
      </div>
      {power && (
        <button
          type="button"
          className="nam-chain-power"
          data-active={power.active}
          disabled={power.disabled}
          onClick={(event) => {
            event.stopPropagation();
            power.onToggle();
          }}
          title={power.title}
          aria-label={power.title}
          aria-pressed={power.active}
        >
          <Power size={12} />
        </button>
      )}
    </article>
  );
}
