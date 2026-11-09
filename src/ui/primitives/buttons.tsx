/**
 * Buttons, chips, labels and small marks (CORTEX-UX §4.9). Owner: E11.
 * Icons are Obsidian's Lucide set: the element carries data-icon and a layout effect calls setIcon() once it is
 * mounted (setIcon replaces the element's children with the SVG). Section labels are 12 px/600 sentence case
 * (nothing in Cortex is set in capitals except key names). Every interactive element is at least 24 × 24 px.
 */
import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { setIcon } from "obsidian";
import { CORTEX_ICON_ID, LUCIDE, type IconName } from "../icons";

/** Paint an Obsidian icon into an element (no-op where setIcon is unavailable). */
export function paintIcon(el: HTMLElement | null, id: string): void {
  if (!el) return;
  try {
    setIcon(el, id);
  } catch {
    // Outside Obsidian (string rendering, tests) the data-icon attribute is enough.
  }
}

export function Icon(p: { name: IconName; class?: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const id = LUCIDE[p.name];
  useLayoutEffect(() => paintIcon(ref.current, id), [id]);
  return <span ref={ref} class={`cx-icon${p.class ? ` ${p.class}` : ""}`} data-icon={id} aria-hidden="true" />;
}

/** The Cortex glyph (registered by main.ts as "cortex-glyph"); `spinning` rotates it while agents run. */
export function Glyph(p: { size?: 12 | 14 | 15 | 20; spinning?: boolean; class?: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => paintIcon(ref.current, CORTEX_ICON_ID), []);
  const cls = ["cx-glyph", `is-${p.size ?? 20}`, p.spinning ? "is-spinning" : "", p.class ?? ""].filter(Boolean).join(" ");
  return <span ref={ref} class={cls} data-icon={CORTEX_ICON_ID} aria-hidden="true" />;
}

export interface IconButtonProps {
  icon: IconName;
  /** Accessible name and tooltip ("Lines · K"). */
  label: string;
  /** Toggle buttons expose aria-pressed and draw the accent dot when on. */
  pressed?: boolean;
  onClick(e: MouseEvent): void;
  onContextMenu?(e: MouseEvent): void;
  size?: 28 | 32;
  disabled?: boolean;
  /** Roving tab index inside toolbars. */
  tabIndex?: number;
  class?: string;
  /** Marks the button that toggles a popover, so outside clicks on it do not close and reopen it. */
  popoverToggle?: string;
  hasPopup?: "menu" | "dialog";
  expanded?: boolean;
  /** Part of a toolbar with a roving tab index (primitives/controls rovingKeyDown). */
  roving?: boolean;
}

export function IconButton(p: IconButtonProps): JSX.Element {
  const cls = ["cx-icon-button", `s${p.size ?? 28}`, p.pressed ? "is-on" : "", p.class ?? ""].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      class={cls}
      aria-label={p.label}
      aria-pressed={p.pressed === undefined ? undefined : p.pressed}
      aria-haspopup={p.hasPopup}
      aria-expanded={p.expanded}
      title={p.label}
      disabled={p.disabled}
      tabIndex={p.tabIndex}
      data-cx-popover-toggle={p.popoverToggle}
      data-roving={p.roving ? "" : undefined}
      onClick={(e) => p.onClick(e as unknown as MouseEvent)}
      onContextMenu={
        p.onContextMenu
          ? (e) => {
              e.preventDefault();
              p.onContextMenu?.(e as unknown as MouseEvent);
            }
          : undefined
      }
    >
      <Icon name={p.icon} />
    </button>
  );
}

export function Button(p: { children: ComponentChildren; onClick(e: MouseEvent): void; primary?: boolean; disabled?: boolean; icon?: IconName; class?: string; title?: string }): JSX.Element {
  return (
    <button type="button" class={`cx-button${p.primary ? " is-primary" : ""}${p.class ? ` ${p.class}` : ""}`} disabled={p.disabled} title={p.title} onClick={(e) => p.onClick(e as unknown as MouseEvent)}>
      {p.icon ? <Icon name={p.icon} /> : null}
      <span>{p.children}</span>
    </button>
  );
}

export function TextButton(p: { children: ComponentChildren; onClick(e: MouseEvent): void; class?: string; disabled?: boolean }): JSX.Element {
  return (
    <button type="button" class={`cx-text-button${p.class ? ` ${p.class}` : ""}`} disabled={p.disabled} onClick={(e) => p.onClick(e as unknown as MouseEvent)}>
      {p.children}
    </button>
  );
}

/** Machine chips are dashed; your own labels are solid (CORTEX-UX §4.9). */
export function Chip(p: { children: ComponentChildren; machine?: boolean; title?: string }): JSX.Element {
  return (
    <span class={`cx-chip${p.machine ? " is-machine" : " is-yours"}`} title={p.title}>
      {p.children}
    </span>
  );
}

export function SectionLabel(p: { children: ComponentChildren; right?: ComponentChildren; id?: string }): JSX.Element {
  return (
    <div class="cx-section-label" id={p.id}>
      <span>{p.children}</span>
      {p.right ? <span class="cx-section-right">{p.right}</span> : null}
    </div>
  );
}

export function StatusPill(p: { state: "ok" | "warn" | "serious" | "critical" | "accent" | "muted"; children: ComponentChildren }): JSX.Element {
  return (
    <span class={`cx-status-pill is-${p.state}`}>
      <span class="cx-status-dot" aria-hidden="true" />
      {p.children}
    </span>
  );
}

/** A key name ("Ctrl K"). */
export function Kbd(p: { children: ComponentChildren }): JSX.Element {
  return <kbd class="cx-kbd">{p.children}</kbd>;
}

/** A colour dot (8 px) for keys, chips and lists; `hollow` for No value buckets. */
export function Dot(p: { color: string; hollow?: boolean; size?: number }): JSX.Element {
  const size = p.size ?? 8;
  const style = p.hollow ? { width: `${size}px`, height: `${size}px`, border: `1.5px solid ${p.color}` } : { width: `${size}px`, height: `${size}px`, background: p.color };
  return <span class={`cx-dot${p.hollow ? " is-hollow" : ""}`} style={style} aria-hidden="true" />;
}
