/**
 * Key popover (CORTEX-UX §5.3): opened from "+‹n›", the picker's "All groups…" or the M-size Key button. 320 px,
 * at most 60% of the stage high (stage-local left 16, top 86). "Filter groups" search; per population a
 * two-column list (notes, entries) with dot, name and a toggle per row; hierarchical dimensions (Folder path)
 * show a tree with disclosure chevrons and solo-on-Alt (SPEC F67); the "Single colour" swatch row of the 8 slots
 * when a population uses one; footer "Hide items without a value". No match: "No groups match “‹text›”."
 * Owner: E11.
 */
import { Fragment, type JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { bucketCss, hueCount, normaliseHex, rgbCss } from "../../shared/palette";
import type { ColourMode, LegendChild, LegendRow, LegendSection } from "../../shared/protocol/worker";
import type { PaletteId } from "../../shared/settings";
import { openPopover, setColourMode, setView, showAllGroups, soloGroup, toggleGroup } from "../../state/actions";
import { SHELL } from "../breakpoints";
import { num, useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { isDesktopHost } from "../host";
import { keyTipsShown, setKeyTipsShown } from "../deviceState";
import { panelTitleClass, usePanelBusy } from "../loading";
import { IconButton } from "../primitives/buttons";
import { Popover, Toggle } from "../primitives/controls";
import { AgeKey, anyHidden, groupKey, modeLabel, populationLabel, rowName, selectedRow } from "./KeyBar";
import { OpenBadge, ReadLimitFilter } from "./KeyConsent";

/** Rows matching a filter; ancestors of a match stay visible so the tree keeps its shape. */
export function filterRows(rows: readonly LegendRow[], q: string): LegendRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...rows];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const keep = new Set<string>();
  for (const r of rows) {
    if (!r.name.toLowerCase().includes(needle)) continue;
    let cur: LegendRow | undefined = r;
    while (cur && !keep.has(cur.key)) {
      keep.add(cur.key);
      cur = cur.parentKey ? byKey.get(cur.parentKey) : undefined;
    }
  }
  return rows.filter((r) => keep.has(r.key));
}

/** Rows visible under the disclosure state (children of collapsed rows are hidden). */
export function visibleTreeRows(rows: readonly LegendRow[], expanded: ReadonlySet<string>, filtering: boolean): LegendRow[] {
  if (filtering) return [...rows];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return rows.filter((r) => {
    let p = r.parentKey ? byKey.get(r.parentKey) : undefined;
    while (p) {
      if (!expanded.has(p.key)) return false;
      p = p.parentKey ? byKey.get(p.parentKey) : undefined;
    }
    return true;
  });
}

/** The year row the month tree opens with: the most recent one (null when the section has no month tree). */
export function latestYearKey(rows: readonly LegendRow[]): string | null {
  let latest: string | null = null;
  for (const r of rows) if (r.aggregate && r.expandable && (latest === null || r.key > latest)) latest = r.key;
  return latest;
}

/**
 * The rows that are open: the most recent year of a month tree by default, then the reader's own choices on top
 * (`true` opens a row, `false` closes it, so closing the recent year stays closed).
 */
export function openRows(rows: readonly LegendRow[], choices: ReadonlyMap<string, boolean>): Set<string> {
  const out = new Set<string>();
  const latest = latestYearKey(rows);
  if (latest !== null) out.add(latest);
  for (const [key, open] of choices) {
    if (open) out.add(key);
    else out.delete(key);
  }
  return out;
}

/** One section's own open/close choices out of the popover's (keyed "population|row", so Brain and Spine stay apart). */
export function sectionChoices(all: ReadonlyMap<string, boolean>, population: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const prefix = `${population}|`;
  for (const [k, v] of all) if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
  return out;
}

/**
 * The keys Alt + click keeps apart: a month's siblings are the other months (never the years, or the month's own year
 * would hide it); every other row's are the top-level rows.
 */
export function soloScope(rows: readonly LegendRow[], row: LegendRow): string[] {
  const tree = rows.some((r) => r.aggregate);
  return rows.filter((r) => (tree && !row.aggregate ? !r.aggregate : r.depth === 0)).map((r) => r.key);
}

/**
 * The subfolder rows to show under a row: only for the selected group of an Area or Folder section (the worker lists
 * them largest first, the direct-members row leading). Empty for any other row.
 */
export function childRowsFor(sec: Pick<LegendSection, "children">, row: LegendRow, selectedKey: string | null): LegendChild[] {
  if (selectedKey === null || selectedKey !== row.key) return [];
  return sec.children?.[row.key] ?? [];
}

/** The lines of the help footer, in order; the spine line follows the spine direction. */
export function helpLines(spineOrder: "oldest-at-brain" | "newest-at-brain"): string[] {
  return [t("key.tipPoint"), t("key.tipDrag"), t(spineOrder === "newest-at-brain" ? "key.tipSpineNewest" : "key.tipSpineOldest")];
}

/** The hex a single-colour mode shows: its own colour when it has one, else its palette slot's colour. */
export function singleHex(mode: ColourMode, palette: PaletteId): string {
  if (mode.kind !== "single") return "";
  return (mode.hex !== undefined && normaliseHex(mode.hex)) || bucketCss("value", mode.slot, palette, "glow");
}

/** The swatch strip's white: a single colour with this hex (the Display panel's strip offers it; the Key popover does not). */
export const WHITE_HEX = "#ffffff";

/**
 * The palette slots, then any colour: a colour well and a hex field (invalid text is kept as typed and flagged).
 * The conic swatch is a button that opens the colour well. `strip` (the Display panel) adds a white swatch and keeps
 * the well and hex field closed until the conic swatch is pressed (or a custom colour is already in use).
 */
export function Swatches(p: { mode: ColourMode; onPick(slot: number): void; onHex(hex: string): void; strip?: boolean }): JSX.Element {
  const s = useServices();
  const palette = s.settings.value.appearance.palette;
  const n = hueCount(palette);
  const ownHex = p.mode.kind === "single" && p.mode.hex !== undefined ? normaliseHex(p.mode.hex) : null;
  const white = p.strip === true && ownHex === WHITE_HEX;
  const custom = ownHex !== null && !white;
  const current = p.mode.kind === "single" && ownHex === null ? p.mode.slot : 0;
  const hex = singleHex(p.mode, palette);
  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const well = useRef<HTMLInputElement>(null);
  const invalid = draft !== null && normaliseHex(draft) === null;
  const showEditor = p.strip !== true || editing || custom;
  return (
    <>
      <div class="cx-swatches" role="radiogroup" aria-label={t("key.singleColour")}>
        {Array.from({ length: n }, (_, i) => i + 1).map((slot) => (
          <button
            key={slot}
            type="button"
            role="radio"
            aria-checked={slot === current}
            aria-label={`${t("key.singleColour")} ${slot}`}
            class={`cx-swatch${slot === current ? " is-on" : ""}`}
            style={{ background: bucketCss("value", slot, palette, "glow") }}
            onClick={() => {
              setDraft(null);
              p.onPick(slot);
            }}
          />
        ))}
        {p.strip ? (
          <button
            type="button"
            role="radio"
            aria-checked={white}
            aria-label={t("display.white")}
            title={t("display.white")}
            class={`cx-swatch is-white${white ? " is-on" : ""}`}
            onClick={() => {
              setDraft(null);
              p.onHex(WHITE_HEX);
            }}
          />
        ) : null}
        <button
          type="button"
          class={`cx-swatch is-custom${custom ? " is-on" : ""}`}
          aria-label={t("key.customColour")}
          aria-pressed={showEditor}
          title={t("key.customColour")}
          onClick={() => {
            setEditing(true);
            well.current?.click();
          }}
        />
      </div>
      <div class="cx-custom-colour" hidden={!showEditor}>
        <input
          ref={well}
          type="color"
          aria-label={t("key.customColour")}
          value={hex}
          onInput={(e) => {
            setDraft(null);
            p.onHex((e.currentTarget as HTMLInputElement).value);
          }}
        />
        <input
          type="text"
          class="cx-input cx-hex"
          aria-label={t("key.hexLabel")}
          title={invalid ? t("key.hexHint") : t("key.hexLabel")}
          aria-invalid={invalid ? "true" : undefined}
          spellcheck={false}
          maxLength={7}
          value={draft ?? hex}
          onInput={(e) => {
            const text = (e.currentTarget as HTMLInputElement).value;
            const ok = normaliseHex(text);
            // A full colour applies as it is typed; "#abc" waits for Enter or leaving the field, or it would
            // be rewritten to "#aabbcc" before the rest of "#abcdef" could be typed.
            if (ok && text.trim().replace("#", "").length === 6) {
              setDraft(null);
              p.onHex(ok);
            } else setDraft(text);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          onBlur={() => {
            const ok = draft === null ? null : normaliseHex(draft);
            if (ok) p.onHex(ok);
            setDraft(null);
          }}
        />
      </div>
    </>
  );
}

export function KeyPopover(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const legend = store.slices.legend.value;
  const view = store.slices.view.value;
  const [q, setQ] = useState("");
  // The reader's own open/close choices, kept while the popover is open; the rest follow the default (latest year open).
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map());
  const close = () => openPopover(store, null);
  const busy = usePanelBusy("key");
  const g = SHELL.geometry;
  // At most 70% of the stage high; the card scrolls inside that.
  const maxH = Math.max(160, Math.floor((shell.size.value.height || SHELL.figure.reference.height) * Math.max(g.popover.keyMaxFraction, 0.7)));
  const tips = keyTipsShown(s.device.value);
  const sections: LegendSection[] = legend?.sections ?? [];
  let matches = 0;
  return (
    <Popover id="key" label={t("key.allGroups")} class="cx-key-popover" style={isDesktopHost() ? undefined : { left: `${g.inset}px`, top: `${g.popover.keyTop}px`, maxHeight: `${maxH}px` }} onClose={close}>
      <header class={panelTitleClass(busy)}>
        <h3>
          {t("key.label")}
          {sections[0] ? <span class="cx-key-dimname"> {modeLabel(sections[0].population === "record" ? view.colour.record : view.colour.notes, sections[0].dim)}</span> : null}
        </h3>
        {legend ? <span class="cx-key-head-total">{legend.lit !== undefined ? t("key.matching", { n: num(legend.lit) }) : t("key.total", { n: num(legend.grandTotal) })}</span> : null}
        <IconButton icon="close" label={t("header.close")} onClick={close} />
      </header>
      <input class="cx-input cx-key-filter" type="search" placeholder={t("key.filter")} aria-label={t("key.filter")} value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
      <ReadLimitFilter />
      <div class="cx-key-list">
        {sections.map((sec) => {
          const mode = sec.population === "record" ? view.colour.record : view.colour.notes;
          const dim = String(sec.dim);
          const expanded = openRows(sec.rows, sectionChoices(choices, sec.population));
          const rows = visibleTreeRows(filterRows(sec.rows, q), expanded, q.trim().length > 0);
          matches += rows.length;
          const selected = selectedRow(sec.rows);
          return (
            <section key={sec.population} class="cx-key-section" aria-label={populationLabel(sec.population)}>
              <div class="cx-key-section-head">
                <span>
                  {populationLabel(sec.population)} · <span class="cx-key-dimname">{modeLabel(mode, sec.dim)}</span>
                </span>
                {rows.length > 0 ? (
                  <span class="cx-key-cols" aria-hidden="true">
                    <span>{t("pages.brain")}</span>
                    <span>{t("key.spine")}</span>
                  </span>
                ) : null}
              </div>
              {mode.kind === "single" ? (
                <Swatches
                  mode={mode}
                  onPick={(slot) => setColourMode(store, sec.population === "record" ? "record" : "notes", { kind: "single", slot })}
                  onHex={(hex) => setColourMode(store, sec.population === "record" ? "record" : "notes", { kind: "single", slot: mode.slot, hex })}
                />
              ) : null}
              {sec.dim === "age" ? <AgeKey sec={sec} /> : null}
              <ul class="cx-key-rows" role="list">
                {rows.map((r) => {
                  const key = groupKey(dim, r.key);
                  const open = expanded.has(r.key);
                  const isSelected = selected?.key === r.key;
                  const kids = q.trim() ? [] : childRowsFor(sec, r, selected?.key ?? null);
                  return (
                    <Fragment key={r.key}>
                      <li class={`cx-key-item${r.hidden ? " is-hidden" : ""}${r.aggregate ? " is-year" : ""}${isSelected ? " is-selected" : ""}`} style={{ paddingLeft: `${8 + r.depth * 14}px` }}>
                        {r.expandable ? (
                          <button
                            type="button"
                            class={`cx-disclosure${open ? " is-open" : ""}`}
                            aria-expanded={open}
                            aria-label={t(open ? "key.collapseGroup" : "key.expandGroup", { name: r.name })}
                            onClick={() => setChoices(new Map(choices).set(`${sec.population}|${r.key}`, !open))}
                          />
                        ) : (
                          <span class="cx-disclosure-space" aria-hidden="true" />
                        )}
                        {/* A click selects the group: it is the only one shown, and a second click clears it. */}
                        <button type="button" class="cx-key-item-main" aria-pressed={isSelected} title={t("key.chipHint")} onClick={() => soloGroup(store, key, soloScope(sec.rows, r).map((k) => groupKey(dim, k)))}>
                          <span class={`cx-key-dot${r.bucket === "none" ? " is-hollow" : ""}`} style={r.bucket === "none" ? { borderColor: rgbCss(r.rgb) } : { background: rgbCss(r.rgb) }} aria-hidden="true" />
                          <span class="cx-key-item-name">{rowName(r, dim)}</span>
                          <OpenBadge dim={dim} rowKey={r.key} />
                          <span class="cx-key-item-count">{num(r.notes)}</span>
                          <span class="cx-key-item-count">{num(r.record)}</span>
                        </button>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={!r.hidden}
                          aria-label={t("key.chipTip", { group: rowName(r, dim), notes: num(r.notes), entries: num(r.record) })}
                          class={`cx-toggle is-inline${r.hidden ? "" : " is-on"}`}
                          onClick={() => toggleGroup(store, key)}
                        >
                          <span class="cx-toggle-knob" />
                        </button>
                      </li>
                      {kids.map((c) => (
                        <li key={`${r.key}>${c.key}`} class={`cx-key-item cx-key-child${c.direct ? " is-direct" : ""}`} style={{ paddingLeft: `${8 + (r.depth + 1) * 14 + 14}px` }} aria-label={t("key.subfolders", { name: r.name })}>
                          <span class="cx-key-item-name" title={c.direct ? rowName(r, dim) : c.key}>
                            {c.direct ? rowName(r, dim) : c.name}
                          </span>
                          <span class="cx-key-item-count">{num(c.notes)}</span>
                          <span class="cx-key-item-count">{num(c.record)}</span>
                        </li>
                      ))}
                    </Fragment>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {q.trim() && matches === 0 ? <p class="cx-note">{t("key.noMatch", { q: q.trim() })}</p> : null}
        {!legend ? <p class="cx-note">{t("key.nothing")}</p> : null}
      </div>
      <footer class="cx-popover-foot">
        <button type="button" class="cx-key-showall is-wide" disabled={!anyHidden(store.slices.ui.value.hiddenGroups)} onClick={() => showAllGroups(store)}>
          {t("key.showEvery")}
        </button>
        <Toggle label={t("key.hideNoValue")} checked={view.colour.hideNoValue} onChange={(x) => setView(store, "colour", { ...view.colour, hideNoValue: x })} />
        {tips ? (
          <div class="cx-key-help" role="note">
            {helpLines(view.spineOrder).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ) : null}
        <Toggle label={t("key.tips")} checked={tips} onChange={(x) => s.device.update((d) => setKeyTipsShown(d, x))} />
      </footer>
    </Popover>
  );
}
