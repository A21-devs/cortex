/**
 * Form controls and overlay primitives (CORTEX-UX §4.9, §8.3). Owner: E11.
 *  - Toggle: role="switch" (Obsidian's pill shape; 30 × 18 on the stage, accent fill when on).
 *  - Slider: 2 px track, accent fill to the thumb, 14 px thumb; arrow keys 5%, Shift + arrows 1%, Page keys 10%,
 *    Home / End; pointer drags with capture; optional ticks, end labels, release callback (snapping) and
 *    double-click on the thumb. role="slider" with aria-valuetext.
 *  - Segmented: a radio group; arrow keys move the selection (roving tab index).
 *  - Select: a button showing the value and a chevron that opens an Obsidian Menu (never a native <select>).
 *  - Popover: a non-modal dialog that closes on Esc and on a pointer press outside it and its toggle.
 *  - Roving tab index for toolbars (tabs, key chips, tools, compass segments, strip bars): Tab enters, arrows
 *    move, Tab leaves.
 * All controls are keyboard accessible and name themselves.
 */
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { showMenu, type MenuItemSpec } from "./menu";

let uid = 0;
/** A stable id for aria attributes (unique per mounted control, also across several Cortex leaves). */
export function useId(prefix: string): string {
  const ref = useRef<string | null>(null);
  if (ref.current === null) ref.current = `${prefix}-${++uid}`;
  return ref.current;
}

// ───────────────────────────── Toggle ─────────────────────────────

export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange(v: boolean): void;
  hint?: string;
  disabled?: boolean;
  /** Smaller pill for section headers (24 × 14). */
  inline?: boolean;
}

export function Toggle(p: ToggleProps): JSX.Element {
  const id = useId("cx-toggle");
  return (
    <div class={`cx-row cx-toggle-row${p.disabled ? " is-disabled" : ""}`}>
      <span class="cx-row-label" id={`${id}-l`}>
        {p.label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={p.checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={p.hint ? `${id}-h` : undefined}
        disabled={p.disabled}
        class={`cx-toggle${p.checked ? " is-on" : ""}${p.inline ? " is-inline" : ""}`}
        onClick={() => p.onChange(!p.checked)}
      >
        <span class="cx-toggle-knob" />
      </button>
      {p.hint ? (
        <span class="cx-row-hint" id={`${id}-h`}>
          {p.hint}
        </span>
      ) : null}
    </div>
  );
}

// ───────────────────────────── Slider ─────────────────────────────

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Keyboard step for Shift + arrows; plain arrows move 5× this. Default: 1% of the range. */
  step?: number;
  onInput(v: number): void;
  /** Pointer released or a keyboard change finished (snapping happens here). */
  onRelease?(v: number): void;
  /** First pointer drag of a gesture (one-time hints). */
  onDragStart?(): void;
  /** Formatted value shown at the right of the label row; omit for range sliders with end labels. */
  format?: (v: number) => string;
  /** aria-valuetext; defaults to `format`. */
  valueText?: (v: number) => string;
  /** aria-valuenow / min / max are the value × this (100 for percentages and the 0–100 shape slider). */
  ariaScale?: number;
  ends?: [string, string];
  /** Tick marks at fractions of the range (the shape slider's 25 / 50 / 75%). */
  ticks?: readonly number[];
  /** No label row (the shape bar labels its ends instead). */
  bare?: boolean;
  onThumbDoubleClick?(): void;
  disabled?: boolean;
  class?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Keyboard step rules of §4.9 as a pure function (returns null for keys the slider does not use). */
export function sliderKey(key: string, shift: boolean, value: number, min: number, max: number, step?: number): number | null {
  const range = max - min;
  const fine = step ?? range / 100;
  const coarse = shift ? fine : fine * 5;
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return clamp(value - coarse, min, max);
    case "ArrowRight":
    case "ArrowUp":
      return clamp(value + coarse, min, max);
    case "PageDown":
      return clamp(value - range / 10, min, max);
    case "PageUp":
      return clamp(value + range / 10, min, max);
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return null;
  }
}

export function Slider(p: SliderProps): JSX.Element {
  const id = useId("cx-slider");
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; started: boolean } | null>(null);
  const span = p.max - p.min || 1;
  const frac = clamp((p.value - p.min) / span, 0, 1);
  const scale = p.ariaScale ?? 1;
  const text = p.valueText ?? p.format;
  const fromX = (clientX: number): number => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return p.value;
    return p.min + clamp((clientX - r.left) / r.width, 0, 1) * span;
  };
  const onPointerDown = (e: PointerEvent) => {
    if (p.disabled || e.button !== 0) return;
    const el = track.current;
    if (!el) return;
    el.setPointerCapture?.(e.pointerId);
    drag.current = { pointer: e.pointerId, started: false };
    el.focus();
    p.onInput(fromX(e.clientX));
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (!d.started) {
      d.started = true;
      p.onDragStart?.();
    }
    p.onInput(fromX(e.clientX));
  };
  const end = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    track.current?.releasePointerCapture?.(e.pointerId);
    p.onRelease?.(fromX(e.clientX));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (p.disabled) return;
    const next = sliderKey(e.key, e.shiftKey, p.value, p.min, p.max, p.step);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    p.onInput(next);
    p.onRelease?.(next);
  };
  return (
    <div class={`cx-slider${p.bare ? " is-bare" : ""}${p.disabled ? " is-disabled" : ""}${p.class ? ` ${p.class}` : ""}`}>
      {p.bare ? null : (
        <div class="cx-row">
          <span class="cx-row-label" id={`${id}-l`}>
            {p.label}
          </span>
          {p.format ? <span class="cx-row-value">{p.format(p.value)}</span> : null}
        </div>
      )}
      <div
        ref={track}
        class="cx-slider-track"
        role="slider"
        tabIndex={p.disabled ? -1 : 0}
        aria-labelledby={p.bare ? undefined : `${id}-l`}
        aria-label={p.bare ? p.label : undefined}
        aria-valuemin={Math.round(p.min * scale)}
        aria-valuemax={Math.round(p.max * scale)}
        aria-valuenow={Math.round(p.value * scale)}
        aria-valuetext={text ? text(p.value) : undefined}
        aria-disabled={p.disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKeyDown}
      >
        <span class="cx-slider-rail" />
        <span class="cx-slider-fill" style={{ width: `${(frac * 100).toFixed(2)}%` }} />
        {(p.ticks ?? []).map((t) => (
          <span key={t} class="cx-slider-tick" style={{ left: `${(t * 100).toFixed(2)}%` }} />
        ))}
        <span
          class="cx-slider-thumb"
          style={{ left: `${(frac * 100).toFixed(2)}%` }}
          onDblClick={
            p.onThumbDoubleClick
              ? (e) => {
                  e.stopPropagation();
                  p.onThumbDoubleClick?.();
                }
              : undefined
          }
        />
      </div>
      {p.ends ? (
        <div class="cx-slider-ends">
          <span>{p.ends[0]}</span>
          <span>{p.ends[1]}</span>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────── Select (picker) ─────────────────────────────

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  group?: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string> {
  label: string;
  value: V;
  options: readonly SelectOption<V>[];
  onChange(v: V): void;
  indent?: boolean;
  /** Without the label column (inline pickers such as the strip's period picker). */
  bare?: boolean;
  /** What the button says while the value matches no option (instead of the raw value). */
  placeholder?: string;
}

/** Picker: a button showing the value and a chevron that opens an Obsidian Menu (never a native <select>). */
export function Select<V extends string>(p: SelectProps<V>): JSX.Element {
  const current = p.options.find((o) => o.value === p.value);
  const open = (el: HTMLElement) => {
    const items: MenuItemSpec<V>[] = p.options.map((o) => ({ value: o.value, label: o.label, group: o.group, checked: o.value === p.value, disabled: o.disabled }));
    // The checked choice opens under the button; after a choice the button keeps a white focus border (is-picked).
    showMenu(
      items,
      el,
      (v) => {
        el.classList.add("is-picked");
        el.addEventListener("blur", () => el.classList.remove("is-picked"), { once: true });
        el.focus({ preventScroll: true });
        p.onChange(v);
      },
      { overChecked: true },
    );
  };
  const button = (
    <button
      type="button"
      class="cx-select"
      aria-haspopup="menu"
      aria-label={`${p.label}: ${current?.label ?? p.placeholder ?? p.value}`}
      onClick={(e) => open(e.currentTarget as HTMLElement)}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          open(e.currentTarget as HTMLElement);
        }
      }}
    >
      <span class="cx-select-value">{current?.label ?? p.placeholder ?? p.value}</span>
      <span class="cx-select-caret" aria-hidden="true" />
    </button>
  );
  if (p.bare) return button;
  return (
    <div class={`cx-row${p.indent ? " is-indented" : ""}`}>
      <span class="cx-row-label">{p.label}</span>
      {button}
    </div>
  );
}

// ───────────────────────────── Segmented ─────────────────────────────

export interface SegmentedProps<V extends string> {
  value: V;
  options: readonly { value: V; label: string; disabled?: boolean }[];
  onChange(v: V): void;
  label: string;
  /** Visually labelled by a row label instead of aria-label. */
  labelledBy?: string;
}

export function Segmented<V extends string>(p: SegmentedProps<V>): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const move = (dir: 1 | -1, from: number) => {
    const enabled = p.options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const pos = Math.max(0, enabled.indexOf(from));
    const next = enabled[(pos + dir + enabled.length) % enabled.length] ?? 0;
    const opt = p.options[next];
    if (!opt) return;
    p.onChange(opt.value);
    const btn = ref.current?.querySelectorAll<HTMLElement>("[role='radio']")[next];
    btn?.focus();
  };
  return (
    <div ref={ref} class="cx-segmented" role="radiogroup" aria-label={p.labelledBy ? undefined : p.label} aria-labelledby={p.labelledBy}>
      {p.options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === p.value}
          tabIndex={o.value === p.value ? 0 : -1}
          disabled={o.disabled}
          class={`cx-seg${o.value === p.value ? " is-on" : ""}`}
          onClick={() => p.onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              move(1, i);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              move(-1, i);
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────── roving tab index ─────────────────────────────

const ROVING = "[data-roving]:not([disabled])";

/**
 * Keyboard movement inside a toolbar-like group: arrows (per orientation), Home and End move focus between items
 * marked `data-roving`; exactly one item stays in the tab order. Returns true when it handled the key.
 */
export function rovingKeyDown(e: KeyboardEvent, container: HTMLElement | null, orientation: "horizontal" | "vertical" | "both" = "horizontal"): boolean {
  if (!container) return false;
  const items = Array.from(container.querySelectorAll<HTMLElement>(ROVING));
  if (items.length === 0) return false;
  const active = container.ownerDocument?.activeElement as HTMLElement | null;
  const i = active ? items.indexOf(active) : -1;
  const prevKeys = orientation === "vertical" ? ["ArrowUp"] : orientation === "horizontal" ? ["ArrowLeft"] : ["ArrowLeft", "ArrowUp"];
  const nextKeys = orientation === "vertical" ? ["ArrowDown"] : orientation === "horizontal" ? ["ArrowRight"] : ["ArrowRight", "ArrowDown"];
  let to = -1;
  if (nextKeys.includes(e.key)) to = i < 0 ? 0 : (i + 1) % items.length;
  else if (prevKeys.includes(e.key)) to = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  else if (e.key === "Home") to = 0;
  else if (e.key === "End") to = items.length - 1;
  if (to < 0) return false;
  e.preventDefault();
  for (const [k, el] of items.entries()) el.tabIndex = k === to ? 0 : -1;
  items[to]?.focus();
  return true;
}

/** Keep exactly one roving item tabbable (the focused or pressed one, else the first) after each render. */
export function useRoving(ref: { current: HTMLElement | null }): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>(ROVING));
    if (items.length === 0) return;
    const active = el.ownerDocument?.activeElement as HTMLElement | null;
    let keep = items.findIndex((x) => x === active);
    if (keep < 0) keep = items.findIndex((x) => x.tabIndex === 0);
    if (keep < 0) keep = 0;
    for (const [k, item] of items.entries()) item.tabIndex = k === keep ? 0 : -1;
  });
}

// ───────────────────────────── Popover ─────────────────────────────

export interface PopoverProps {
  /** Matches the `data-cx-popover-toggle` of the button that opens it. */
  id: string;
  label: string;
  class?: string;
  style?: JSX.CSSProperties;
  onClose(): void;
  children: ComponentChildren;
  /** Move focus into the popover when it opens (default true). */
  autoFocus?: boolean;
}

/** A non-modal dialog on the stage: Esc and a press outside close it; focus returns to its toggle. */
export function Popover(p: PopoverProps): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const onClose = useRef(p.onClose);
  onClose.current = p.onClose;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const doc = el.ownerDocument;
    const toggle = doc.querySelector<HTMLElement>(`[data-cx-popover-toggle="${p.id}"]`);
    if (p.autoFocus !== false) {
      const first = el.querySelector<HTMLElement>("button:not([disabled]), [tabindex='0'], input, [role='slider']");
      first?.focus();
    }
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (!t || el.contains(t)) return;
      const toggleHit = (t as Element).closest?.(`[data-cx-popover-toggle="${p.id}"]`);
      if (toggleHit) return;
      onClose.current();
    };
    doc.addEventListener("pointerdown", onDown, true);
    return () => {
      doc.removeEventListener("pointerdown", onDown, true);
      const active = doc.activeElement;
      if (toggle && (active === null || active === doc.body || el.contains(active))) toggle.focus();
    };
  }, [p.id]);
  return (
    <section
      ref={ref}
      class={`cx-popover${p.class ? ` ${p.class}` : ""}`}
      role="dialog"
      aria-label={p.label}
      style={p.style}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose.current();
        }
      }}
    >
      {p.children}
    </section>
  );
}
