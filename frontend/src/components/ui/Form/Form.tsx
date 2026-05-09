import classNames from "classnames";
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Slider } from "../Slider";

type BannerTone = "info" | "success" | "warning" | "danger";

interface FormSectionProps {
  title: string;
  description?: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}

interface FormGridProps {
  children: ReactNode;
  columns?: 1 | 2;
  className?: string;
}

interface FormFieldProps {
  label?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  unit?: string;
  description?: string;
  onChange: (value: number) => void;
}

interface StatusBannerProps {
  tone?: BannerTone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

interface AdvancedDisclosureProps {
  title?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

const bannerToneClasses: Record<BannerTone, string> = {
  info: "border-cyan-800/50 bg-cyan-950/20 text-cyan-100",
  success: "border-emerald-800/50 bg-emerald-950/20 text-emerald-100",
  warning: "border-yellow-700/40 bg-yellow-950/30 text-yellow-100",
  danger: "border-red-700/40 bg-red-950/30 text-red-100",
};

function formatSliderValue(value: number, unit?: string) {
  const rounded =
    Math.abs(value) >= 10
      ? Number(value.toFixed(2))
      : Number(value.toFixed(3));
  return `${rounded}${unit ? ` ${unit}` : ""}`;
}

export function FormSection({
  title,
  description,
  meta,
  children,
  className,
}: FormSectionProps) {
  return (
    <section
      className={classNames(
        "rounded-md border border-neutral-800 bg-neutral-950/50 p-4",
        className,
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-daw-text-muted">
            {title}
          </p>
          {description ? (
            <p className="mt-1 text-xs leading-5 text-daw-text-secondary">
              {description}
            </p>
          ) : null}
        </div>
        {meta ? <div className="shrink-0">{meta}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function FormGrid({ children, columns = 2, className }: FormGridProps) {
  return (
    <div
      className={classNames(
        columns === 1 ? "space-y-3" : "grid grid-cols-1 gap-3 md:grid-cols-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function FormField({ label, description, children, className }: FormFieldProps) {
  return (
    <div className={classNames("space-y-1.5", className)}>
      {label ? (
        <div>
          <p className="text-sm font-medium text-daw-text-muted">{label}</p>
          {description ? (
            <p className="mt-0.5 text-xs leading-5 text-daw-text-secondary">
              {description}
            </p>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  unit,
  description,
  onChange,
}: SliderFieldProps) {
  return (
    <FormField label={label} description={description}>
      <div className="rounded-md border border-neutral-800 bg-neutral-950/70 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-daw-text-muted">
            {label}
          </span>
          <span className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[11px] text-daw-text">
            {formatSliderValue(value, unit)}
          </span>
        </div>
        <Slider
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={onChange}
        />
      </div>
    </FormField>
  );
}

export function StatusBanner({
  tone = "info",
  title,
  children,
  actions,
  className,
}: StatusBannerProps) {
  return (
    <div
      className={classNames(
        "rounded-md border px-4 py-3 text-sm",
        bannerToneClasses[tone],
        className,
      )}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          {title ? <p className="font-semibold text-current">{title}</p> : null}
          {children ? (
            <div className={classNames("text-xs leading-5", title && "mt-1")}>
              {children}
            </div>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
    </div>
  );
}

export function AdvancedDisclosure({
  title = "Advanced",
  children,
  defaultOpen = false,
  className,
}: AdvancedDisclosureProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={classNames("rounded-md border border-neutral-800 bg-neutral-950/30", className)}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.14em] text-daw-text-muted hover:text-daw-text"
        onClick={() => setIsOpen((value) => !value)}
      >
        <span>{title}</span>
        <ChevronDown
          size={15}
          className={classNames("transition-transform", isOpen && "rotate-180")}
        />
      </button>
      {isOpen ? <div className="border-t border-neutral-800 p-3">{children}</div> : null}
    </div>
  );
}
