"use client";
/**
 * Interface primitives: buttons, chips, switches, tooltips, badges.
 * Everything here is presentational; data comes from callers.
 */
import clsx from "clsx";
import { LoaderCircle } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { NODE_STATE_STYLES, EDGE_STATE_STYLES, PROVENANCE_STYLES, SYSTEM_STYLES } from "@/lib/systems";
import type { EdgeState, NodeState, ProvenanceCategory, SystemType } from "@/types/infrastructure";

export const cx = clsx;

// ---------------------------------------------------------------------------
// Tooltip (portal, so it is never clipped by scroll containers)
// ---------------------------------------------------------------------------

type Side = "top" | "bottom" | "left" | "right";

export function Tooltip({
  label,
  shortcut,
  side = "bottom",
  children,
  className,
  disabled,
}: {
  label: ReactNode;
  shortcut?: string;
  side?: Side;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [pos, setPos] = useState<{ left: number; top: number; transform: string } | null>(null);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setPos(null);
  }, []);
  const show = useCallback(() => {
    if (disabled) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const clampX = (x: number) => Math.min(vw - 90, Math.max(90, x));
      if (side === "bottom") setPos({ left: clampX(r.left + r.width / 2), top: r.bottom + 8, transform: "translateX(-50%)" });
      else if (side === "top") setPos({ left: clampX(r.left + r.width / 2), top: r.top - 8, transform: "translate(-50%,-100%)" });
      else if (side === "left") setPos({ left: r.left - 8, top: r.top + r.height / 2, transform: "translate(-100%,-50%)" });
      else setPos({ left: r.right + 8, top: r.top + r.height / 2, transform: "translateY(-50%)" });
    }, 260);
  }, [side, disabled]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <span
      ref={ref}
      className={cx(!/(^|\s)(block|flex|grid|hidden)(\s|$)/.test(className ?? "") && "inline-flex", className)}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
      onPointerDown={hide}
    >
      {children}
      {pos &&
        createPortal(
          <div
            role="tooltip"
            style={{ left: pos.left, top: pos.top, transform: pos.transform }}
            className="pointer-events-none fixed z-[200] flex max-w-[280px] items-center gap-2 rounded-md border border-white/10 bg-ink-900/95 px-2 py-1 text-[11.5px] leading-snug text-ink-100 shadow-xl backdrop-blur"
          >
            <span>{label}</span>
            {shortcut && <Kbd>{shortcut}</Kbd>}
          </div>,
          document.body,
        )}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-white/12 bg-white/[0.05] px-1 font-mono text-[10px] leading-none text-ink-200",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = "ghost" | "subtle" | "primary" | "danger" | "outline" | "success";
type Size = "xs" | "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  ghost: "text-ink-200 hover:text-ink-50 hover:bg-white/[0.06]",
  subtle: "bg-white/[0.05] text-ink-100 border border-white/[0.08] hover:bg-white/[0.09] hover:border-white/[0.14]",
  outline: "text-ink-100 border border-white/[0.14] hover:bg-white/[0.06] hover:border-white/25",
  primary: "bg-ink-50 text-ink-950 hover:bg-white font-medium shadow-[0_0_0_1px_rgba(255,255,255,0.2)]",
  danger: "bg-alert/[0.14] text-[#fda4af] border border-alert/30 hover:bg-alert/[0.22] hover:border-alert/50",
  success: "bg-ok/[0.12] text-[#86efac] border border-ok/30 hover:bg-ok/[0.2]",
};

const SIZES: Record<Size, string> = {
  xs: "h-6 px-2 text-[11px] gap-1 rounded-md",
  sm: "h-7 px-2.5 text-[12px] gap-1.5 rounded-md",
  md: "h-8 px-3 text-[12.5px] gap-2 rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export function Button({
  variant = "subtle",
  size = "sm",
  icon,
  loading,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors duration-150 select-none",
        "disabled:pointer-events-none disabled:opacity-40",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  tooltipSide?: Side;
  pressed?: boolean;
  size?: "xs" | "sm" | "md";
  tone?: "default" | "accent";
}

export function IconButton({
  label,
  shortcut,
  tooltipSide = "bottom",
  pressed,
  size = "md",
  className,
  children,
  type = "button",
  tone = "default",
  ...rest
}: IconButtonProps) {
  const dim = size === "xs" ? "size-6 rounded-md" : size === "sm" ? "size-7 rounded-md" : "size-8 rounded-lg";
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      <button
        type={type}
        aria-label={label}
        aria-pressed={pressed}
        className={cx(
          "inline-flex shrink-0 items-center justify-center transition-colors duration-150 disabled:pointer-events-none disabled:opacity-35",
          dim,
          pressed
            ? tone === "accent"
              ? "bg-sky-300/[0.14] text-sky-100 shadow-[inset_0_0_0_1px_rgba(125,211,252,0.35)]"
              : "bg-white/[0.11] text-ink-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
            : "text-ink-200 hover:bg-white/[0.07] hover:text-ink-50",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  label,
  color = "#7dd3fc",
  size = "md",
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  color?: string;
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  const w = size === "sm" ? "w-6 h-3.5" : "w-7 h-4";
  const knob = size === "sm" ? "size-2.5" : "size-3";
  const travel = size === "sm" ? 10 : 12;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-200 disabled:opacity-40",
        w,
        checked ? "border-transparent" : "border-white/15 bg-white/[0.04]",
      )}
      style={checked ? { background: `${color}cc`, boxShadow: `0 0 12px -2px ${color}88` } : undefined}
    >
      <span
        className={cx("absolute left-[1px] rounded-full transition-transform duration-200", knob)}
        style={{
          transform: `translateX(${checked ? travel : 0}px)`,
          background: checked ? "#04060b" : "#6b7791",
        }}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dots, chips, badges
// ---------------------------------------------------------------------------

export function SystemDot({ system, size = 8, className }: { system: SystemType; size?: number; className?: string }) {
  const c = SYSTEM_STYLES[system]?.color ?? "#94a3b8";
  return (
    <span
      aria-hidden
      className={cx("inline-block shrink-0 rounded-full", className)}
      style={{ width: size, height: size, background: c, boxShadow: `0 0 8px -1px ${c}aa` }}
    />
  );
}

export function Chip({
  children,
  color,
  className,
  style,
  title,
}: {
  children: ReactNode;
  color?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] border px-1.5 font-mono text-[9.5px] leading-none font-medium tracking-[0.08em] uppercase",
        !color && "border-white/12 text-ink-200",
        className,
      )}
      style={color ? { color, borderColor: `${color}55`, background: `${color}14`, ...style } : style}
    >
      {children}
    </span>
  );
}

export function StateChip({ state, kind = "node" }: { state: NodeState | EdgeState; kind?: "node" | "edge" }) {
  const s =
    kind === "node" ? NODE_STATE_STYLES[state as NodeState] : EDGE_STATE_STYLES[state as EdgeState];
  if (!s) return <Chip>{String(state)}</Chip>;
  return (
    <Chip color={s.impacted ? s.color : "#9fb3c8"}>
      <span className="size-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </Chip>
  );
}

export function ProvenanceChip({ category, className }: { category: ProvenanceCategory; className?: string }) {
  const p = PROVENANCE_STYLES[category];
  if (!p) return null;
  const simulated = category === "simulated";
  return (
    <span
      title={`${p.label}: ${p.description}`}
      className={cx(
        "inline-flex h-[18px] shrink-0 items-center rounded-[5px] border px-1.5 font-mono text-[9.5px] leading-none font-medium tracking-[0.1em]",
        simulated && "dt-hatch border-dashed",
        className,
      )}
      style={{ color: p.color, borderColor: `${p.color}${simulated ? "88" : "55"}`, background: simulated ? undefined : `${p.color}12` }}
    >
      {p.short}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx("size-3.5 animate-spin text-ink-300", className)} aria-hidden />;
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function SectionLabel({
  children,
  right,
  className,
}: {
  children: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex items-center justify-between gap-2", className)}>
      <h3 className="dt-label">{children}</h3>
      {right}
    </div>
  );
}

export function PanelHeader({
  icon,
  title,
  subtitle,
  actions,
  accent,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-white/[0.07] pr-1.5 pl-3.5">
      {icon && (
        <span className="flex size-5 items-center justify-center text-ink-300" style={accent ? { color: accent } : undefined}>
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-display text-[12.5px] font-semibold tracking-[0.12em] text-ink-50 uppercase">{title}</h2>
        {subtitle && <div className="truncate text-[11px] leading-tight text-ink-300">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-0.5">{actions}</div>}
    </div>
  );
}

export function KeyValue({
  label,
  children,
  mono,
  hint,
}: {
  label: ReactNode;
  children: ReactNode;
  mono?: boolean;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[5px]">
      <dt className="shrink-0 text-[12px] text-ink-300">{label}</dt>
      <dd className={cx("min-w-0 text-right text-[12.5px] text-ink-100", mono && "dt-num")}>
        {children}
        {hint && <span className="ml-1.5 text-[10.5px] text-ink-400">{hint}</span>}
      </dd>
    </div>
  );
}

/** Thin horizontal composition bar (e.g. provenance shares). */
export function ShareBar({
  parts,
  height = 4,
  className,
}: {
  parts: { key: string; value: number; color: string; hatched?: boolean; label?: string }[];
  height?: number;
  className?: string;
}) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className={cx("flex w-full gap-px overflow-hidden rounded-full bg-white/[0.04]", className)} style={{ height }}>
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <span
            key={p.key}
            title={p.label ? `${p.label}: ${Math.round((p.value / total) * 100)}%` : undefined}
            className={cx("h-full", p.hatched && "dt-hatch")}
            style={{
              width: `${(p.value / total) * 100}%`,
              backgroundColor: p.hatched ? `${p.color}55` : p.color,
            }}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slider: native range input (keyboard + a11y for free) over a custom track
// ---------------------------------------------------------------------------

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  color = "#7dd3fc",
  marks,
  format,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  color?: string;
  marks?: number[];
  format?: (v: number) => string;
  disabled?: boolean;
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className={cx("relative h-5 w-full", disabled && "opacity-40")}>
      <div className="absolute top-1/2 right-0 left-0 h-[3px] -translate-y-1/2 rounded-full bg-white/[0.08]" />
      <div
        className="absolute top-1/2 left-0 h-[3px] -translate-y-1/2 rounded-full"
        style={{ width: `${pct}%`, background: color, boxShadow: `0 0 10px -2px ${color}` }}
      />
      {marks?.map((m) => (
        <span
          key={m}
          aria-hidden
          className="absolute top-1/2 h-[7px] w-px -translate-y-1/2 bg-white/20"
          style={{ left: `${((m - min) / (max - min)) * 100}%` }}
        />
      ))}
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-ink-950"
        style={{ left: `${pct}%`, borderColor: color }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={format ? format(value) : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
        className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </div>
  );
}
