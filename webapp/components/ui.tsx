"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-accent text-bg shadow-[0_10px_24px_rgb(var(--color-accent)_/_0.22)] hover:opacity-90",
  secondary:
    "border-line bg-bg-panel/78 text-ink-dim shadow-sm hover:border-accent/50 hover:bg-bg-panel hover:text-ink",
  ghost:
    "border-transparent bg-transparent text-ink-dim hover:bg-bg-panel/70 hover:text-ink",
  danger:
    "border-danger/50 bg-danger/10 text-danger hover:bg-danger/20 hover:text-danger",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-3.5 text-sm",
};

export function Button({
  variant = "secondary",
  size = "sm",
  icon: Icon,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {Icon ? <Icon aria-hidden className="h-4 w-4 shrink-0" /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  variant?: ButtonVariant;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors disabled:pointer-events-none disabled:opacity-40",
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    >
      <Icon aria-hidden className="h-4 w-4" />
    </button>
  );
}

export function PageHeader({
  title,
  eyebrow,
  meta,
  actions,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-bg-panel/76 px-4 py-2 shadow-[0_8px_26px_rgb(0_0_0_/_0.14)] backdrop-blur-xl">
      <div className="min-w-0">
        {eyebrow ? (
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="truncate text-sm font-semibold text-ink">{title}</h1>
        {meta ? (
          <div className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
            {meta}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  eyebrow,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        "rounded-md border border-line bg-bg-panel/82 shadow-[0_18px_46px_rgb(0_0_0_/_0.16)] backdrop-blur-xl",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              {eyebrow}
            </div>
          ) : null}
          <h2 className="mt-0.5 truncate text-sm font-semibold text-ink">{title}</h2>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const STATUS_TONES = {
  ready: "status-ready",
  running: "status-warning",
  warning: "status-warning",
  skipped: "status-skipped",
  disabled: "status-disabled",
  error: "status-danger",
  info: "status-info",
} as const;

export type StatusTone = keyof typeof STATUS_TONES;

export function StatusBadge({
  tone = "info",
  children,
  className,
}: {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-6 items-center rounded-md border px-2 font-mono text-[10px] font-medium uppercase tracking-wide",
        STATUS_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SegmentControl<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "inline-grid rounded-md border border-line bg-bg-panel/76 p-1 shadow-sm",
        className,
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cx(
            "h-7 rounded px-2.5 text-xs font-medium transition-colors",
            value === option.value
              ? "bg-bg-panel text-ink shadow-[inset_0_0_0_1px_rgb(var(--color-line))]"
              : "text-ink-dim hover:bg-bg-panel/60 hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex min-h-40 flex-col items-center justify-center rounded-md border border-dashed border-line bg-bg-panel/68 px-6 py-8 text-center shadow-sm backdrop-blur-xl",
        className,
      )}
    >
      <div className="text-sm font-medium text-ink">{title}</div>
      {description ? (
        <div className="mt-1 max-w-md text-xs leading-relaxed text-ink-faint">
          {description}
        </div>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "flex min-h-10 items-center justify-between gap-3 border-b border-line bg-bg-panel/55 px-4 py-2 shadow-sm backdrop-blur-xl",
        className,
      )}
    >
      {children}
    </div>
  );
}
