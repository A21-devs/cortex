/**
 * Small visual marks shared by the readers and the sheet pages (CORTEX-UX §4.9). Owner: E12.
 * Colour is never alone (§8.3): speakers also carry a shape (you filled, assistant hollow, another person half,
 * tool a small square), kinds carry a glyph, machine text carries a dotted rule and a model chip, meters carry a
 * tooltip with the counts. Colours come from CSS tokens so the stage palette and theme switch without re-render.
 */
import type { ComponentChildren, JSX } from "preact";
import { useContext, useState } from "preact/hooks";
import { SPACE_ORDER } from "../../shared/index-format";
import { KIND_STYLE } from "../../shared/palette";
import type { NoteKind, SpaceId, Speaker } from "../../shared/types";
import { ServicesContext } from "../context";
import { t } from "../copy";
import { Icon } from "../primitives/buttons";
import type { IconName } from "../icons";
import { areaLabel, kindLabel, sourceLabel, speakerLabel } from "../valueLabels";
import { sectionOpen, setSectionOpen } from "../deviceState";

/** Speaker marker: you filled amber, assistant hollow violet, another person half, tool a small square. */
export function SpeakerMarker(p: { speaker: Speaker; title?: string }): JSX.Element {
  return <span class={`cx-speaker-mark is-${p.speaker}`} role="img" aria-label={p.title ?? speakerLabel(p.speaker)} title={p.title ?? speakerLabel(p.speaker)} />;
}

/** The kind glyph box (◆ ? ▸ × ✶ ◎ ≡; a map is ✦ in a solid white box). */
export function KindGlyph(p: { kind: NoteKind | "map" | string; title?: string }): JSX.Element {
  const isMap = p.kind === "hub" || p.kind === "map";
  const style = (KIND_STYLE as Record<string, { slot: number; glyph: string } | undefined>)[p.kind];
  const glyph = isMap ? "✦" : style?.glyph ?? "•";
  const colour = style ? `var(--cx-cat-${style.slot})` : "var(--cx-text-2)";
  const label = p.title ?? kindLabel(isMap ? "map" : p.kind);
  return (
    <span class={`cx-kind-glyph${isMap ? " is-map" : ""}`} style={{ color: colour }} role="img" aria-label={label} title={label}>
      {glyph}
    </span>
  );
}

/** Model chip: dashed pill, mono, glyph first — "sonnet · 4 Nov". */
export function ModelChip(p: { children: ComponentChildren; title?: string }): JSX.Element {
  return (
    <span class="cx-model-chip" title={p.title}>
      <span class="cx-model-chip-glyph" aria-hidden="true">
        ◌
      </span>
      {p.children}
    </span>
  );
}

/** Your share of the words: a 4 px bar, your part amber on top, the rest violet. */
export function SplitBar(p: { share: number; tall?: boolean }): JSX.Element {
  const pct = Math.round(Math.max(0, Math.min(1, Number.isFinite(p.share) ? p.share : 0)) * 100);
  const tip = t("read.yourShare", { p: pct });
  return <span class={`cx-split-bar${p.tall ? " is-tall" : ""}`} style={{ "--share": `${pct}%` } as JSX.CSSProperties} role="img" aria-label={tip} title={tip} />;
}

/** Evidence meter: quotes from you (amber) over quotes from the assistant (violet), quarters up to 4 quotes. */
export function EvidenceMeter(p: { you: number; assistant: number }): JSX.Element {
  const q = (n: number) => Math.round((Math.max(0, Math.min(4, n)) / 4) * 100);
  const tip = t("reader.evidence", { you: p.you, assistant: p.assistant });
  return (
    <span class="cx-evidence" role="img" aria-label={tip} title={tip}>
      <span class="cx-evidence-bar is-you">
        <span style={{ width: `${q(p.you)}%` }} />
      </span>
      <span class="cx-evidence-bar is-assistant">
        <span style={{ width: `${q(p.assistant)}%` }} />
      </span>
    </span>
  );
}

/** Colour slot (1..8) of an area: the sticky slot when Cortex assigned one, else its fixed order. */
export function areaSlot(space: string, slots?: Readonly<Record<string, number>>): number | null {
  if (space === "none") return null;
  const sticky = slots?.[space];
  if (sticky !== undefined && sticky >= 1 && sticky <= 8) return sticky;
  const i = (SPACE_ORDER as readonly string[]).indexOf(space);
  return i < 0 ? null : (i % 8) + 1;
}

function useAreaSlots(): Readonly<Record<string, number>> | undefined {
  const s = useContext(ServicesContext);
  if (!s) return undefined;
  try {
    return s.colours.current()["space"];
  } catch {
    return undefined;
  }
}

/** Area dot + name; "No area" in slate. */
export function AreaDot(p: { space: SpaceId | string; label?: boolean }): JSX.Element {
  const slot = areaSlot(p.space, useAreaSlots());
  const name = areaLabel(p.space);
  const background = slot === null ? "var(--cx-none)" : `var(--cx-cat-${slot})`;
  if (p.label === false) return <span class="cx-area-dot" style={{ background }} role="img" aria-label={name} title={name} />;
  return (
    <span class="cx-area" title={name}>
      <span class="cx-area-dot" style={{ background }} aria-hidden="true" />
      <span class="cx-area-name">{name}</span>
    </span>
  );
}

const SOURCE_ICONS: Readonly<Record<string, IconName>> = {
  "claude-code": "conversation",
  "claude-ai": "conversation",
  chatgpt: "conversation",
  gemini: "conversation",
  obsidian: "document",
  files: "folder",
  written: "newEntry",
  outcome: "check",
  "cortex-ask": "history",
  notion: "document",
  "google-docs": "document",
  whatsapp: "conversation",
  telegram: "conversation",
  discord: "conversation",
  slack: "conversation",
  zoom: "conversation",
  keep: "document",
  evernote: "document",
  roam: "document",
  kindle: "document",
  "codex-cli": "conversation",
  "gemini-cli": "conversation",
  cursor: "conversation",
  capture: "conversation",
};

/** Source icon (Lucide) with the source name for screen readers; `label` also prints it. */
export function SourceIcon(p: { source: string; label?: boolean }): JSX.Element {
  const name = sourceLabel(p.source);
  return (
    <span class="cx-source" title={name}>
      <Icon name={SOURCE_ICONS[p.source] ?? "document"} />
      {p.label ? <span class="cx-source-name">{name}</span> : <span class="cx-sr-only">{name}</span>}
    </span>
  );
}

/** 96 × 20 sparkline of weekly counts, bars brighter toward now. */
export function Sparkline(p: { values: readonly number[]; label: string; width?: number; height?: number }): JSX.Element {
  const w = p.width ?? 96;
  const h = p.height ?? 20;
  const n = Math.max(1, p.values.length);
  const max = Math.max(1, ...p.values.map((v) => (Number.isFinite(v) ? v : 0)));
  const bw = w / n;
  return (
    <svg class="cx-sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={p.label}>
      {p.values.map((v, i) => {
        const bh = Math.max(v > 0 ? 1.5 : 0, (Math.max(0, v) / max) * (h - 2));
        return <rect x={i * bw + 0.5} y={h - bh} width={Math.max(1, bw - 1.5)} height={bh} rx={1} style={{ opacity: 0.35 + 0.65 * ((i + 1) / n) }} />;
      })}
    </svg>
  );
}

/** A labelled section: 12 px/600 label, optional right-hand slot, then the body. */
export function Section(p: { label: ComponentChildren; right?: ComponentChildren; children?: ComponentChildren; id?: string; class?: string; collapsible?: boolean; count?: number; defaultOpen?: boolean }): JSX.Element {
  const services = useContext(ServicesContext);
  const key = p.id ?? "";
  const dflt = p.defaultOpen !== false;
  const [open, setOpenState] = useState(() => {
    if (!p.collapsible) return true;
    try {
      return sectionOpen(services?.device.value ?? {}, key, dflt);
    } catch {
      return dflt;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpenState(next);
    try {
      services?.device.update((d) => setSectionOpen(d, key, next));
    } catch {
      // a device that cannot save keeps the choice for this session only
    }
  };
  const shown = !p.collapsible || open;
  const heading = p.count !== undefined ? (
    <>
      {p.label} ({p.count})
    </>
  ) : (
    p.label
  );
  return (
    <section class={`cx-section${p.class ? ` ${p.class}` : ""}${p.collapsible ? ` is-collapsible${open ? " is-open" : ""}` : ""}`} aria-labelledby={p.id}>
      <div class="cx-section-label">
        {p.collapsible ? (
          <button type="button" class="cx-section-toggle" id={p.id} aria-expanded={open} onClick={toggle}>
            <Icon name="chevron" class="cx-section-chevron" />
            <span>{heading}</span>
          </button>
        ) : (
          <span id={p.id}>{heading}</span>
        )}
        {p.right && shown ? <span class="cx-section-right">{p.right}</span> : null}
      </div>
      {shown ? p.children : null}
    </section>
  );
}

/** One quote row: speaker marker, the exact quote in quotation marks, the date at the right. */
export function QuoteRow(p: { speaker?: Speaker; quote: string; date?: string; valid?: boolean; named?: boolean; onOpen?: () => void }): JSX.Element {
  const who = p.speaker ?? "other";
  const body = (
    <>
      <SpeakerMarker speaker={who} />
      {p.named ? <span class="cx-quote-who">{who === "you" ? t("reader.you") : who === "assistant" ? t("reader.quoteAssistant") : speakerLabel(who)}</span> : null}
      <span class={`cx-quote-text${p.valid === false ? " is-stale" : ""}`}>“{p.quote}”</span>
      {p.date ? <span class="cx-quote-date cx-mono">{p.date}</span> : null}
    </>
  );
  return p.onOpen ? (
    <button type="button" class="cx-quote" onClick={p.onOpen}>
      {body}
    </button>
  ) : (
    <div class="cx-quote">{body}</div>
  );
}
