/**
 * Scope picker (CORTEX-UX §5.1, ORIG-16): a 28 px pill on --cx-chrome-alt with a 14 px ring of the top area
 * colours and "All areas", or one area's dot and name, and a chevron button. The name part: click = the next area,
 * mouse wheel = step, and resting on it for 700 ms starts a hover preview that cycles every 900 ms (leaving
 * restores; clicking while it shows commits the shown area) (header/spaceCycle.ts, SPEC F13). The chevron opens an
 * Obsidian Menu: "All areas" (total) · each area with its dot, name and count in slot order · "No area" ·
 * "Previous area [" · "Next area ]"; resting on a row for 300 ms previews that area (others at 35%). [ and ] and the
 * compass change scope too; the camera turns the chosen wedge toward the viewer and its members flash (render).
 * At S the pill is an icon whose click opens the menu (wheel and hover still work). Owner: E11.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { NO_AREA, SPACES, spaceName } from "../../shared/spaces";
import { SPACE_ORDER } from "../../shared/index-format";
import { bucketCss, paletteById } from "../../shared/palette";
import type { PaletteId } from "../../shared/settings";
import type { SpaceId } from "../../shared/types";
import { isUserScope, userScope, type UserSpace } from "../../shared/userSpaces";
import type { CortexStore } from "../../state/store";
import { indexCounts, num, useLeaf, useServices, useShell, type IndexCounts } from "../context";
import { t } from "../copy";
import { SLOT_ICON_IDS } from "../icons";
import { Icon } from "../primitives/buttons";
import { showMenu, type MenuItemSpec } from "../primitives/menu";
import { createWheelGate, cycleOrder, startHoverCycle, stepCycle, type HoverCycle, type Scope } from "./spaceCycle";
import { chooseScope, currentScope, spaceOfScope, useUserSpaceSync } from "./userSpaceScope";

/** The name of a scope; one of the person's own spaces is named from `userSpaces` (an unknown one reads as All areas). */
export function scopeLabel(scope: Scope, userSpaces: readonly UserSpace[] = []): string {
  if (isUserScope(scope)) return spaceOfScope(scope, userSpaces)?.name ?? t("header.allAreas");
  return scope === "all" ? t("header.allAreas") : spaceName(scope);
}

export interface AreaRow {
  id: SpaceId;
  name: string;
  /** Sticky colour slot 1..8, or 0 when the area folds into Other. */
  slot: number;
  notes: number;
  entries: number;
}

/**
 * Areas in slot order (the sticky Area slots), then unslotted areas by size; "none" last. Areas with nothing in
 * them are left out unless scoped. Without an index every known area is listed in its fixed order.
 */
export function areaRows(slots: Readonly<Record<string, number>> | undefined, counts: IndexCounts | null, scope: SpaceId | "all" = "all"): AreaRow[] {
  const rows: AreaRow[] = SPACE_ORDER.filter((id) => id !== "none").map((id) => ({
    id,
    name: SPACES.find((sp) => sp.id === id)?.name ?? id,
    slot: slots?.[id] ?? 0,
    notes: counts?.notesBySpace[id] ?? 0,
    entries: counts?.recordBySpace[id] ?? 0,
  }));
  const kept = counts ? rows.filter((r) => r.notes + r.entries > 0 || r.id === scope) : rows;
  return kept.sort((a, b) => {
    if (a.slot && b.slot) return a.slot - b.slot;
    if (a.slot) return -1;
    if (b.slot) return 1;
    return counts ? b.notes + b.entries - (a.notes + a.entries) : SPACE_ORDER.indexOf(a.id) - SPACE_ORDER.indexOf(b.id);
  });
}

export function scopeMenuItems(current: Scope, rows: readonly AreaRow[] = areaRows(undefined, null), counts: IndexCounts | null = null, userSpaces: readonly UserSpace[] = []): MenuItemSpec[] {
  const total = counts ? counts.notes + counts.record : undefined;
  const items: MenuItemSpec[] = [{ value: "all", label: t("header.allAreas"), checked: current === "all", icon: SLOT_ICON_IDS.ring, detail: total === undefined ? undefined : num(total) }];
  for (const r of rows) {
    items.push({ value: r.id, label: r.name, group: "areas", checked: current === r.id, icon: r.slot ? SLOT_ICON_IDS.slot(r.slot) : SLOT_ICON_IDS.other, detail: counts ? num(r.notes + r.entries) : undefined });
  }
  const none = counts ? counts.notesBySpace.none ?? 0 : 0;
  const noneEntries = counts ? counts.recordBySpace.none ?? 0 : 0;
  items.push({ value: "none", label: NO_AREA.name, group: "areas", checked: current === "none", icon: SLOT_ICON_IDS.none, detail: counts ? num(none + noneEntries) : undefined });
  for (const u of userSpaces) {
    if (u.areas.length + u.folders.length === 0) continue;
    items.push({ value: userScope(u.id), label: u.name, group: "spaces", checked: current === userScope(u.id), icon: "star" });
  }
  items.push({ value: "prev", label: t("header.previousArea"), group: "step" }, { value: "next", label: t("header.nextArea"), group: "step" });
  return items;
}

/** Apply a scope menu choice. */
export function pickScope(store: CortexStore, current: Scope, v: string, userSpaces: readonly UserSpace[] = []): void {
  if (v === "prev" || v === "next") chooseScope(store, stepCycle(["all", ...SPACE_ORDER, ...cycleOrder([], null, userSpaces).filter(isUserScope)], current, v === "next" ? 1 : -1), userSpaces);
  else if (v === "all" || (SPACE_ORDER as readonly string[]).includes(v) || isUserScope(v)) chooseScope(store, v as Scope, userSpaces);
}

/** Open the scope menu (header pill, compass caption). */
export function openScopeMenu(anchor: HTMLElement, store: CortexStore, slots: Readonly<Record<string, number>> | undefined, counts: IndexCounts | null, userSpaces: readonly UserSpace[] = []): void {
  const ui = store.get("ui");
  const current = currentScope(ui, userSpaces);
  const areaScope = ui.scope;
  showMenu(scopeMenuItems(current, areaRows(slots, counts, areaScope), counts, userSpaces), anchor, (v) => pickScope(store, current, v, userSpaces), {
    hoverDelayMs: 300,
    // Resting on an area lights it; one of the person's spaces has no single area to light, so it previews nothing.
    onHover: (v) => store.update("ui", { preview: v && v !== "prev" && v !== "next" && v !== "all" && !isUserScope(v) ? { kind: "area", key: v } : null }),
    onHide: () => {
      if (store.get("ui").preview?.kind === "area") store.update("ui", { preview: null });
    },
  });
}

/** The ring of the top area colours (CSS conic gradient), largest first. */
export function ringGradient(rows: readonly AreaRow[], palette: PaletteId, light: boolean): string {
  const top = rows.filter((r) => r.slot > 0).slice(0, 7);
  const variant = light ? "light" : "glow";
  if (top.length === 0) return `conic-gradient(${bucketCss("none", 0, palette, variant)} 0 100%)`;
  const weights = top.map((r) => Math.max(1, r.notes + r.entries));
  const sum = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  const stops = top.map((r, i) => {
    const from = (acc / sum) * 100;
    acc += weights[i] ?? 0;
    return `${bucketCss("value", r.slot, palette, variant)} ${from.toFixed(1)}% ${((acc / sum) * 100).toFixed(1)}%`;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

export function ScopePicker(p: { iconOnly?: boolean }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  useUserSpaceSync();
  const userSpaces = s.settings.value.userSpaces ?? [];
  const uiNow = leaf.store.slices.ui.value;
  const real: Scope = currentScope(uiNow, userSpaces);
  const [previewed, setPreviewed] = useState<Scope | null>(null);
  const cycle = useRef<HoverCycle | null>(null);
  const wheel = useRef(createWheelGate());
  // The chip shows the previewed area while the hover cycle runs, and the real one otherwise.
  const scope = previewed ?? real;
  const settings = s.settings.value;
  const counts = indexCounts(s);
  let slots: Readonly<Record<string, number>> | undefined;
  try {
    slots = s.colours.current().space;
  } catch {
    slots = undefined;
  }
  const rows = areaRows(slots, counts, uiNow.scope);
  const palette = settings.appearance.palette;
  const light = !shell.obsidianDark.value || paletteById(palette).forcesPaper;
  const mine = spaceOfScope(scope, userSpaces);
  const slot = scope === "all" || scope === "none" || mine ? 0 : (slots?.[scope as SpaceId] ?? 0);
  const variant = light ? "light" : "glow";
  // One of the person's spaces shows the first colour of its own palette (or the current one).
  const dot = mine ? bucketCss("value", 1, mine.palette ?? palette, variant) : scope === "none" ? bucketCss("none", 0, palette, variant) : slot ? bucketCss("value", slot, palette, variant) : bucketCss("other", 0, palette, variant);
  const label = scopeLabel(scope, userSpaces);

  const order = (): Scope[] => cycleOrder(areaRows(slots, counts, leaf.store.get("ui").scope), counts, userSpaces);
  const nowScope = (): Scope => currentScope(leaf.store.get("ui"), userSpaces);
  /** Show an area in the chip and light its members (others at 35%) without changing the scope. */
  const preview = (to: Scope | null): void => {
    setPreviewed(to);
    const cur = leaf.store.get("ui").preview;
    if (to !== null && to !== "all" && !isUserScope(to)) leaf.store.update("ui", { preview: { kind: "area", key: to } });
    else if (cur?.kind === "area") leaf.store.update("ui", { preview: null });
  };
  const stopCycle = (): void => {
    cycle.current?.cancel();
    cycle.current = null;
  };
  useEffect(() => stopCycle, []);
  const onEnter = (): void => {
    stopCycle();
    cycle.current = startHoverCycle({ order, current: nowScope, onPreview: preview });
  };
  /** Click: the next area, or the previewed one when the hover cycle is showing it. */
  const onStep = (): void => {
    const shown = previewed;
    stopCycle();
    chooseScope(leaf.store, shown ?? stepCycle(order(), nowScope(), 1), userSpaces);
  };
  const onWheel = (e: WheelEvent): void => {
    const dir = wheel.current(e.deltaY, Date.now());
    e.preventDefault();
    if (dir === 0) return;
    stopCycle();
    chooseScope(leaf.store, stepCycle(order(), nowScope(), dir), userSpaces);
  };
  const openMenu = (e: Event): void => {
    stopCycle();
    openScopeMenu(e.currentTarget as HTMLElement, leaf.store, slots, counts, userSpaces);
  };
  const marker =
    scope === "all" ? (
      <span class="cx-scope-ring" aria-hidden="true" style={{ background: ringGradient(rows, palette, light) }} />
    ) : (
      <span class={`cx-scope-dot${scope === "none" ? " is-hollow" : ""}`} aria-hidden="true" style={scope === "none" ? { borderColor: dot } : { background: dot }} />
    );
  // The small icon (S) has no room for a caret: its click opens the menu; the wheel and the hover cycle still work.
  if (p.iconOnly) {
    return (
      <button
        type="button"
        class="cx-scope is-icon"
        data-scope={scope}
        aria-haspopup="menu"
        aria-label={`${t("compass.label")}: ${label}`}
        title={label}
        onClick={openMenu}
        onMouseEnter={onEnter}
        onMouseLeave={stopCycle}
        onWheel={onWheel}
      >
        {marker}
      </button>
    );
  }
  return (
    <div class="cx-scope" role="group" data-scope={scope} aria-label={t("compass.label")} title={t("header.scopeTip")} onMouseEnter={onEnter} onMouseLeave={stopCycle} onWheel={onWheel}>
      <button type="button" class="cx-scope-main" aria-label={`${t("compass.label")}: ${label}`} onClick={onStep}>
        {marker}
        <span class="cx-scope-name">{label}</span>
      </button>
      <button type="button" class="cx-scope-menu" aria-haspopup="menu" aria-label={t("header.scopeMenu")} onClick={openMenu}>
        <Icon name="chevron" class="cx-scope-caret" />
      </button>
    </div>
  );
}
