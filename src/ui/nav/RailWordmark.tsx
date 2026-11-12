/**
 * The rail's wordmark: bold "cortex" and a light suffix naming the current area (nothing at All areas), a short
 * palette-gradient bar under it, and the colour helpers the rest of the rail shares (search hairline, meter fills).
 *
 * The word is a lens switcher: resting the pointer on it for 700 ms starts a preview that steps to the next area every
 * 900 ms, and each mouse-wheel notch steps one area (notches closer than 120 ms count as one). Each step rolls the
 * suffix, tints it, and isolates that area live (ui.preview, strong: the figure and the key keep
 * the area and fade the rest to 6%); leaving the word restores. A plain click steps to the next area (wrapping to All
 * areas; while a preview shows an area, that one is kept); the scope menu (header/ScopePicker.openScopeMenu) opens on
 * right-click and from the small chevron beside the word; a click with Ctrl, Shift, Alt or Cmd
 * held, or the small glyph beside it, goes to Brain as the header brand does. The suffix is tinted with the area's
 * palette slot, lifted until it keeps 4.5:1 on the chrome. When the area changes the old name rolls up and out
 * while the new one rises in (about 120 ms, with a one-frame ghost of the old word); reduced motion swaps instantly.
 */
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { bucketCss, contrastRatio, hexToRgb, oklabToSrgb, paletteById, rgbToHex, srgbToOklab, type Variant } from "../../shared/palette";
import type { PaletteId } from "../../shared/settings";
import type { SpaceId } from "../../shared/types";
import { isUserScope, typedFrameMs, typedFrames, type UserSpace } from "../../shared/userSpaces";
import { openTab } from "../../state/actions";
import { indexCounts, isReducedMotion, useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { Glyph, Icon } from "../primitives/buttons";
import { areaRows, openScopeMenu, scopeLabel } from "../header/ScopePicker";
import { clickTarget, createWheelGate, cycleOrder, startHoverCycle, stepCycle, type HoverCycle, type Scope } from "../header/spaceCycle";
import { chooseScope, currentScope, spaceOfScope, useUserSpaceSync } from "../header/userSpaceScope";

/** How long the suffix roll runs (ms): long enough to read, short enough not to hold the click up. */
export const SUFFIX_ROLL_MS = 120;
/** Wheel notches closer together than this are one step of the wordmark's lens. */
export const LENS_WHEEL_MS = 120;
/** How many palette slots make the gradients (the bar, the search hairline, the meter fills). */
export const RAIL_STOPS = 6;
/** Stand-ins for the chrome background when lifting text colours (Obsidian's themes vary a little). */
export const CHROME_BG = { dark: "#262626", light: "#f0f0f0" } as const;

/** Lift (on dark) or lower (on light) a colour's lightness in steps until it keeps `min`:1 on `bg`. */
export function ensureContrast(hex: string, bg: string, min = 4.5): string {
  if (contrastRatio(hex, bg) >= min) return hex;
  const [l, a, b] = srgbToOklab(hexToRgb(hex));
  const up = contrastRatio("#ffffff", bg) > contrastRatio("#000000", bg);
  let lightness = l;
  let out = hex;
  for (let i = 0; i < 40 && contrastRatio(out, bg) < min; i++) {
    lightness = up ? Math.min(1, lightness + 0.025) : Math.max(0, lightness - 0.025);
    out = rgbToHex(oklabToSrgb([lightness, a, b]));
  }
  return out;
}

/** The suffix text for a scope: the area's name (or the person's own space's), or nothing at All areas. */
export function suffixText(scope: Scope, userSpaces: readonly UserSpace[] = []): string {
  return scope === "all" ? "" : scopeLabel(scope, userSpaces);
}

/** The suffix colour: the area's palette slot (Other when unslotted, the No value slate for No area), contrast-clamped. */
export function suffixColour(scope: Scope, slots: Readonly<Record<string, number>> | undefined, palette: PaletteId, variant: Variant, darkChrome: boolean, userSpaces: readonly UserSpace[] = []): string {
  if (scope === "all") return "inherit";
  if (isUserScope(scope)) {
    // One of the person's own spaces takes the first colour of its own palette (or the current one).
    const mine = spaceOfScope(scope, userSpaces);
    return ensureContrast(bucketCss("value", 1, mine?.palette ?? palette, variant), darkChrome ? CHROME_BG.dark : CHROME_BG.light);
  }
  const slot = scope === "none" ? 0 : (slots?.[scope] ?? 0);
  const raw = scope === "none" ? bucketCss("none", 0, palette, variant) : slot ? bucketCss("value", slot, palette, variant) : bucketCss("other", 0, palette, variant);
  return ensureContrast(raw, darkChrome ? CHROME_BG.dark : CHROME_BG.light);
}

/** The first colours of a palette, slot order. */
export function paletteStops(palette: PaletteId, variant: Variant, n = RAIL_STOPS): string[] {
  const out: string[] = [];
  for (let slot = 1; slot <= n; slot++) out.push(bucketCss("value", slot, palette, variant));
  return out;
}

export function stopsGradient(stops: readonly string[], angle = 90): string {
  return `linear-gradient(${angle}deg, ${stops.join(", ")})`;
}

/** One roll: the old word (with its colour) leaving and the new one arriving; null when nothing should animate. */
export interface SuffixRoll {
  from: string;
  to: string;
}

export function suffixRoll(prev: string, next: string, reduced: boolean): SuffixRoll | null {
  if (reduced || prev === next) return null;
  return { from: prev, to: next };
}

/** The palette facts the rail's colour marks share. */
export interface RailPalette {
  palette: PaletteId;
  variant: Variant;
  darkChrome: boolean;
  stops: string[];
  gradient: string;
}

/** Reactive: recomputed when the palette setting or Obsidian's theme changes. */
export function useRailPalette(): RailPalette {
  const s = useServices();
  const shell = useShell();
  const palette = s.settings.value.appearance.palette;
  const darkChrome = shell.obsidianDark.value;
  const variant: Variant = !darkChrome || paletteById(palette).forcesPaper ? "light" : "glow";
  const stops = paletteStops(palette, variant);
  return { palette, variant, darkChrome, stops, gradient: stopsGradient(stops) };
}

export function RailWordmark(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const rp = useRailPalette();
  useUserSpaceSync();
  const userSpaces = s.settings.value.userSpaces ?? [];
  const uiNow = leaf.store.slices.ui.value;
  const scope: Scope = currentScope(uiNow, userSpaces);
  const reduced = isReducedMotion(s.settings.value.appearance.motion, shell.systemReducedMotion.value);
  let slots: Readonly<Record<string, number>> | undefined;
  try {
    slots = s.colours.current().space;
  } catch {
    slots = undefined;
  }
  // The lens: the area the wordmark is previewing (hover cycle or wheel), shown in the suffix instead of the real scope.
  const [lens, setLens] = useState<Scope | null>(null);
  const lensRef = useRef<Scope | null>(null);
  const cycle = useRef<HoverCycle | null>(null);
  const wheel = useRef(createWheelGate(LENS_WHEEL_MS));
  const shown: Scope = lens ?? scope;
  const word = suffixText(shown, userSpaces);
  const colour = suffixColour(shown, slots, rp.palette, rp.variant, rp.darkChrome, userSpaces);
  const [roll, setRoll] = useState<(SuffixRoll & { fromColour: string }) | null>(null);
  // The typed swap (a space of your own, to or from): the word shown so far, or null when none is running.
  const [typed, setTyped] = useState<string | null>(null);
  const last = useRef({ word, colour, scope: shown });
  useLayoutEffect(() => {
    const prev = last.current;
    last.current = { word, colour, scope: shown };
    // A change to or from one of the person's own spaces is typed out; the ten areas keep the roll.
    if (!reduced && prev.word !== word && (isUserScope(prev.scope) || isUserScope(shown))) {
      const frames = typedFrames(prev.word, word);
      const step = typedFrameMs(frames.length);
      let i = 0;
      setRoll(null);
      setTyped(frames[0] ?? word);
      const id = setInterval(() => {
        i += 1;
        if (i >= frames.length) {
          clearInterval(id);
          setTyped(null);
        } else setTyped(frames[i] ?? word);
      }, step);
      return () => {
        clearInterval(id);
        setTyped(null);
      };
    }
    setTyped(null);
    const plan = suffixRoll(prev.word, word, reduced);
    if (!plan) {
      setRoll(null);
      return;
    }
    setRoll({ ...plan, fromColour: prev.colour });
    const id = setTimeout(() => setRoll(null), SUFFIX_ROLL_MS + 40);
    return () => clearTimeout(id);
    // The colour only matters when the word changes; a palette change alone recolours in place.
  }, [word, reduced]);

  const order = (): Scope[] => {
    const counts = indexCounts(s);
    return cycleOrder(areaRows(slots, counts, leaf.store.get("ui").scope), counts, userSpaces);
  };
  const nowScope = (): Scope => currentScope(leaf.store.get("ui"), userSpaces);
  /** Show an area in the suffix and isolate it everywhere (strong preview) without changing the scope; null restores. */
  const preview = (to: Scope | null): void => {
    lensRef.current = to;
    setLens(to);
    const cur = leaf.store.get("ui").preview;
    if (to !== null && to !== "all" && !isUserScope(to)) leaf.store.update("ui", { preview: { kind: "area", key: to, strong: true } });
    else if (cur?.kind === "area") leaf.store.update("ui", { preview: null });
  };
  const stopCycle = (): void => {
    cycle.current?.cancel();
    cycle.current = null;
  };
  useEffect(
    () => () => {
      stopCycle();
      if (lensRef.current !== null) {
        lensRef.current = null;
        if (leaf.store.get("ui").preview?.kind === "area") leaf.store.update("ui", { preview: null });
      }
    },
    [],
  );
  const onEnter = (): void => {
    stopCycle();
    cycle.current = startHoverCycle({ order, current: nowScope, onPreview: preview });
  };
  const onLeave = (): void => {
    stopCycle();
    if (lensRef.current !== null) preview(null);
  };
  const onWheel = (e: WheelEvent): void => {
    const dir = wheel.current(e.deltaY, Date.now());
    e.preventDefault();
    if (dir === 0) return;
    const from = lensRef.current ?? nowScope();
    stopCycle();
    preview(stepCycle(order(), from, dir));
  };
  const onWord = (e: MouseEvent): void => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
      openTab(leaf.store, "brain");
      return;
    }
    // A plain click steps the whole app to the next area (the suffix rolls); while a preview shows an area, that one is kept.
    const kept = lensRef.current;
    stopCycle();
    if (kept !== null) preview(null);
    chooseScope(leaf.store, clickTarget(order(), nowScope(), kept), userSpaces);
  };
  /** The scope menu: right-click on the word, or the chevron beside it. */
  const openMenu = (anchor: HTMLElement): void => {
    const kept = lensRef.current;
    stopCycle();
    if (kept !== null) {
      preview(null);
      chooseScope(leaf.store, kept, userSpaces);
    }
    openScopeMenu(anchor, leaf.store, slots, indexCounts(s), userSpaces);
  };
  const label = scopeLabel(scope, userSpaces);
  return (
    <div class="cx-rail-brand">
      <div class="cx-rail-brand-row">
        <button type="button" class="cx-rail-glyph" aria-label={t("rail.brainTip")} title={t("rail.brainTip")} onClick={() => openTab(leaf.store, "brain")}>
          <Glyph size={14} />
        </button>
        <button
          type="button"
          class="cx-rail-word"
          data-scope={shown}
          aria-haspopup="menu"
          aria-label={t("rail.wordmarkLabel", { area: label })}
          title={t("rail.wordmarkTip")}
          onClick={(e) => onWord(e as unknown as MouseEvent)}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(e.currentTarget as HTMLElement);
          }}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          onWheel={(e) => onWheel(e as unknown as WheelEvent)}
        >
          <span class="cx-rail-word-main">{t("rail.wordmark")}</span>
          <span class={`cx-rail-suffix${roll ? " is-rolling" : ""}`} aria-hidden="true">
            {typed !== null ? (
              <span class="cx-roll-now cx-typing" style={{ color: colour }}>{typed}</span>
            ) : roll ? (
              <>
                {roll.from ? <span class="cx-roll-ghost" style={{ color: roll.fromColour }}>{roll.from}</span> : null}
                {roll.from ? <span class="cx-roll-out" style={{ color: roll.fromColour }}>{roll.from}</span> : null}
                <span class="cx-roll-in" style={{ color: colour }}>{roll.to}</span>
              </>
            ) : (
              <span class="cx-roll-now" style={{ color: colour }}>{word}</span>
            )}
          </span>
        </button>
        <button type="button" class="cx-rail-word-menu" aria-haspopup="menu" aria-label={t("rail.scopeMenu")} title={t("rail.scopeMenu")} onClick={(e) => openMenu(e.currentTarget as HTMLElement)}>
          <Icon name="chevron" />
        </button>
      </div>
      <span class="cx-rail-bar" aria-hidden="true" style={{ background: rp.gradient }} />
    </div>
  );
}
