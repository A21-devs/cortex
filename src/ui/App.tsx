/**
 * The Cortex shell (CORTEX-UX §3): a 44 px header; at XL and L a 168 px left rail (space chip, the thirteen
 * destinations, Show everything, meters; at M and S the header's page picker lists them instead); the stage
 * (canvas + overlays: key bar, shape bar, tool column, compass, command line, toasts, banner); the time strip
 * under the stage; ONE right-hand sheet that holds every page and reader in a back stack (push at XL/L, overlay
 * at M, full at S). There is no second dock. Immersive mode hides everything but the stage and a pill. Owner: E11.
 *
 * The root carries the breakpoint (`bp-XL`…), `is-short` / `is-tiny`, `is-reduced`, `is-flat` (Frosted panels
 * off) and `is-immersive`; the stage wrapper carries the resolved stage (`data-stage`, ink or paper) and the
 * stage tint, so the strip, the stage and its overlays share one set of tokens.
 */
import "@preact/signals";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CortexServices, LeafServices } from "../plugin/services";
import { resolveStage, stageColours, themeAttr, tintedLift } from "../shared/palette";
import { chartCardAside, drawerOpenLeft, railVisible, sheetMode, sheetPair, sheetSide, stashTab, viewFlags } from "./breakpoints";
import { isReducedMotion, LeafContext, ServicesContext, shellFor, ShellContext, type Shell } from "./context";
import { Header } from "./header/Header";
import { isDesktopHost } from "./host";
import { NavRail } from "./nav/Nav";
import { ParkedTab, Sheet } from "./sheet/Sheet";
import { ImmersivePill } from "./stage/ImmersivePill";
import { ProgressLine } from "./stage/LoadingLines";
import { installShowcaseKeys } from "./showcase/runner";
import { Stage } from "./stage/Stage";
import { LockOverlay } from "./stage/LockOverlay";
import { appLocked } from "../state/lock";
import { StripDock } from "./strip/StripDock";
import { TimeStrip } from "./strip/TimeStrip";
import { TourLayer } from "./walkthrough/TourLayer";

/** True for a few hundred milliseconds after the colours (window theme, palette) change, so the window cross-fades. */
function useThemeFade(key: string, off: boolean): boolean {
  const last = useRef(key);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (last.current === key) return undefined;
    last.current = key;
    if (off) return undefined;
    setFading(true);
    const id = setTimeout(() => setFading(false), 450);
    return () => clearTimeout(id);
  }, [key, off]);
  return fading;
}

export function App(p: { services: CortexServices; leaf: LeafServices; shell?: Shell }): JSX.Element {
  const shell = p.shell ?? shellFor(p.leaf);
  const ui = p.leaf.store.slices.ui.value;
  const settings = p.services.settings.value;
  const mode = sheetMode(ui.breakpoint);
  // Two columns (XL, L): a page on its dock side and the reader opposite, the stage between them.
  const pair = sheetPair(ui, shell.size.value.width || undefined);
  const parked = stashTab(ui);
  const side = pair ? pair.pageSide : sheetSide(ui.sheet, ui.breakpoint);
  // At XL and L a left sheet sits between the rail and the stage, so the stage steps aside to the right.
  const sheetFirst = mode === "push" && side === "left";
  const sheetOn = !ui.immersive && ui.sheet.open;
  const rail = railVisible(ui.breakpoint, ui.immersive);
  const flags = viewFlags(shell.size.value.height || Number.POSITIVE_INFINITY);
  const stage = resolveStage(settings.appearance.stage, shell.obsidianDark.value, settings.appearance.palette);
  const theme = themeAttr(settings.appearance.stage, stage);
  const hue = settings.appearance.stageTint;
  const lift = hue === null ? undefined : tintedLift(stageColours(settings.appearance.stage, stage).lift, hue, stage);
  const desktop = isDesktopHost();
  const reduced = isReducedMotion(settings.appearance.motion, shell.systemReducedMotion.value);
  const fading = useThemeFade(`${settings.appearance.stage}|${settings.appearance.palette}`, reduced);
  // Showcase mode's chord (Ctrl+0, then Ctrl+9) on this view's document.
  useEffect(() => installShowcaseKeys(p.services, p.leaf, shell), [p.services, p.leaf, shell]);
  const cls = [
    "cx-root",
    desktop ? "is-desktop" : "",
    `bp-${ui.breakpoint}`,
    flags.short ? "is-short" : "",
    flags.tiny ? "is-tiny" : "",
    reduced ? "is-reduced" : "",
    fading ? "is-theme-fade" : "",
    settings.appearance.frosted ? "" : "is-flat",
    settings.appearance.patterns ? "is-patterns" : "",
    rail ? "has-rail" : "",
    ui.sheet.open ? `has-sheet sheet-${mode} sheet-${side}${pair ? " has-pair" : ""}` : "",
    drawerOpenLeft(ui) ? "is-drawer-left" : "",
    settings.appearance.animatePageChanges ? "is-animate-pages" : "",
    ui.immersive ? "is-immersive" : "",
    appLocked.value ? "is-locked" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <ServicesContext.Provider value={p.services}>
      <LeafContext.Provider value={p.leaf}>
        <ShellContext.Provider value={shell}>
          <div class={cls} role="application" aria-label="Cortex" data-cx-theme={theme}>
            {ui.immersive || desktop ? null : <Header />}
            {ui.immersive || desktop ? null : <ProgressLine />}
            <div class="cx-body">
              {rail ? <NavRail /> : null}
              {parked?.side === "left" ? <ParkedTab mode={mode} /> : null}
              {pair ? <Sheet mode={mode} column={pair.pageSide === "left" ? "page" : "reader"} pair={pair} /> : sheetOn && sheetFirst ? <Sheet mode={mode} /> : null}
              <div class="cx-main" data-stage={stage} data-cx-theme={theme} style={lift ? { "--cx-stage-lift": lift } : undefined}>
                <Stage />
                {ui.immersive || ui.breakpoint === "Mini" ? null : desktop ? <StripDock /> : <TimeStrip />}
              </div>
              {pair ? <Sheet mode={mode} column={pair.pageSide === "right" ? "page" : "reader"} pair={pair} /> : sheetOn && !sheetFirst ? <Sheet mode={mode} /> : null}
              {parked?.side === "right" ? <ParkedTab mode={mode} /> : null}
              {chartCardAside(ui) ? <Sheet mode={mode} column="card" /> : null}
            </div>
            {ui.immersive || ui.breakpoint === "Mini" ? null : <TourLayer />}
            {ui.immersive ? <ImmersivePill /> : null}
            <LockOverlay />
          </div>
        </ShellContext.Provider>
      </LeafContext.Provider>
    </ServicesContext.Provider>
  );
}
