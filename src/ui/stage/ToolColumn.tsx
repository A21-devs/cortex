/**
 * Tool column (CORTEX-UX §5.5): a vertical glass column (stage-local right 16, top 64) of 32 px buttons in three
 * groups separated by 22 px hairlines: Display (O) with a smaller list button under it (opens the Key as a full list) · Chart (C, P1) | Names (L: on hover ↔ always) · Lines (K,
 * P1: selection ↔ all; right-click → Off · Selection · All and "Conversation threads": a shortcut between off and the last strength set by the Display slider) · Spin or Drift (Space: motion on or
 * off, spin standing and drift lying; right-click → ×0.5 · ×1 · ×2) | Home view (H) · Immersive (I). Tooltips
 * "‹name› · ‹key›"; toggles carry aria-pressed and a 5 px accent dot. role="toolbar" vertical with a roving tab
 * index. At S the column is one "Tools" button that opens the same tools as a menu. Owner: E11.
 */
import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import { featureOn } from "../../shared/features";
import { paletteById } from "../../shared/palette";
import { openPopover, setLook, setMotion, toggleImmersive } from "../../state/actions";
import { stemsOn } from "../../state/selectors";
import type { CortexStore } from "../../state/store";
import { STEM_ON_STRENGTH } from "../../state/types";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { motionModeFor, shownShape, toggleChartPage } from "../keymap";
import { IconButton } from "../primitives/buttons";
import { rovingKeyDown, useRoving } from "../primitives/controls";
import { showMenu, type MenuItemSpec } from "../primitives/menu";

export function toolLabel(name: string, key: string): string {
  return t("tools.withKey", { name, key });
}

type ToolValue = "display" | "list" | "chart" | "theme" | "names" | "lines" | "motion" | "home" | "immersive";

/** The strength a view's conversation threads had before the Lines menu switched them off. */
const lastStem = new WeakMap<CortexStore, number>();

/** The Lines menu's shortcut: threads off, or back to the strength they had (the Display popover's slider sets it). */
export function toggleStems(store: CortexStore): void {
  const v = store.get("view");
  if (stemsOn(v)) {
    lastStem.set(store, v.look.stemStrength);
    setLook(store, { stemStrength: 0 });
  } else {
    setLook(store, { stemStrength: lastStem.get(store) ?? STEM_ON_STRENGTH });
  }
}

export function ToolColumn(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const ref = useRef<HTMLDivElement>(null);
  useRoving(ref);
  const ui = leaf.store.slices.ui.value;
  const v = leaf.store.slices.view.value;
  const settings = s.settings.value;
  const store = leaf.store;
  const namesForced = paletteById(settings.appearance.palette).forcesNames;
  const namesAlways = namesForced || v.look.names === "always";
  const chartOn = featureOn("chartPage");
  const linesOn = featureOn("lines");
  const motionOn = v.motion.mode !== "off";
  const motionName = t(v.pose === "lying" ? "display.drift" : "display.spin");
  const home = () => s.bus.emit("camera:fly-to", { viewId: leaf.viewId, home: true });
  const run = (tool: ToolValue) => {
    switch (tool) {
      case "display":
        openPopover(store, "display");
        return;
      case "list":
        openPopover(store, "key");
        return;
      case "chart":
        toggleChartPage(store);
        return;
      case "theme":
        openPopover(store, "themes");
        return;
      case "names":
        if (!namesForced) setLook(store, { names: v.look.names === "always" ? "hover" : "always" });
        return;
      case "lines":
        setLook(store, { lines: v.look.lines === "all" ? "selection" : "all" });
        return;
      case "motion":
        setMotion(store, { mode: motionOn ? "off" : motionModeFor(v.pose) });
        return;
      case "home":
        home();
        return;
      case "immersive":
        toggleImmersive(store);
        return;
    }
  };
  const linesMenu = (anchor: HTMLElement, at?: { x: number; y: number }) =>
    showMenu(
      [
        { value: "off", label: t("tools.linesOff"), checked: v.look.lines === "off" },
        { value: "selection", label: t("tools.linesSelection"), checked: v.look.lines === "selection" },
        { value: "all", label: t("tools.linesAll"), checked: v.look.lines === "all" },
        { value: "stems", label: t("tools.stems"), checked: stemsOn(v), group: "stems" },
      ],
      anchor,
      (x) => (x === "stems" ? toggleStems(store) : setLook(store, { lines: x })),
      { at },
    );
  const speedMenu = (anchor: HTMLElement, at?: { x: number; y: number }) =>
    showMenu(
      ([0.5, 1, 2] as const).map((x) => ({ value: String(x), label: `×${x}`, checked: v.motion.speed === x })),
      anchor,
      (x) => setMotion(store, { speed: Number(x) }),
      { at },
    );
  if (ui.breakpoint === "S") {
    const items: MenuItemSpec<ToolValue>[] = [
      { value: "display", label: toolLabel(t("tools.display"), "O"), icon: "sliders-horizontal", checked: ui.popover === "display" },
      { value: "list", label: t("tools.keyList"), icon: "list", checked: ui.popover === "key" },
      ...(chartOn ? [{ value: "chart" as const, label: toolLabel(t("tools.chart"), "C"), icon: "chart-column", checked: shownShape(v.shape, v.morph) === "chart" }] : []),
      { value: "theme", label: t("tools.theme"), icon: "palette", checked: ui.popover === "themes", group: "look" },
      { value: "names", label: toolLabel(t("tools.names"), "L"), icon: "tag", checked: namesAlways, group: "look" },
      ...(linesOn ? [{ value: "lines" as const, label: toolLabel(t("tools.lines"), "K"), icon: "spline", checked: v.look.lines === "all", group: "look" }] : []),
      { value: "motion", label: toolLabel(motionName, "Space"), icon: "rotate-3d", checked: motionOn, group: "look" },
      { value: "home", label: toolLabel(t("tools.home"), "H"), icon: "house", group: "view" },
      { value: "immersive", label: toolLabel(t("tools.immersive"), "I"), icon: "maximize", group: "view" },
    ];
    return (
      <div class="cx-tools is-collapsed" data-cx-overlay="tools">
        <IconButton icon="tools" size={32} label={t("tools.tools")} hasPopup="menu" popoverToggle="display" onClick={(e) => showMenu(items, e.currentTarget as HTMLElement, run)} />
      </div>
    );
  }
  return (
    <div ref={ref} class="cx-tools" role="toolbar" aria-orientation="vertical" aria-label={t("tools.tools")} data-cx-overlay="tools" onKeyDown={(e) => rovingKeyDown(e as unknown as KeyboardEvent, ref.current, "vertical")}>
      <IconButton icon="display" size={32} class="cx-tool is-panel" roving label={toolLabel(t("tools.display"), "O")} pressed={ui.popover === "display"} popoverToggle="display" hasPopup="dialog" expanded={ui.popover === "display"} onClick={() => run("display")} />
      <IconButton icon="list" size={28} class="cx-tool cx-tool-list is-panel" roving label={t("tools.keyList")} pressed={ui.popover === "key"} popoverToggle="key" hasPopup="dialog" expanded={ui.popover === "key"} onClick={() => run("list")} />
      {chartOn ? <IconButton icon="chart" size={32} class="cx-tool" roving label={toolLabel(t("tools.chart"), "C")} pressed={shownShape(v.shape, v.morph) === "chart"} onClick={() => run("chart")} /> : null}
      <IconButton icon="theme" size={32} class="cx-tool" roving label={t("tools.theme")} pressed={ui.popover === "themes"} popoverToggle="themes" hasPopup="dialog" expanded={ui.popover === "themes"} onClick={() => run("theme")} />
      <span class="cx-tool-sep" aria-hidden="true" />
      <IconButton icon="names" size={32} class="cx-tool" roving label={toolLabel(t("tools.names"), "L")} pressed={namesAlways} disabled={namesForced} onClick={() => run("names")} />
      {linesOn ? (
        <IconButton
          icon="lines"
          size={32}
          class="cx-tool" roving
          label={toolLabel(t("tools.lines"), "K")}
          pressed={v.look.lines === "all"}
          onClick={() => run("lines")}
          onContextMenu={(e) => linesMenu(e.currentTarget as HTMLElement, { x: e.clientX, y: e.clientY })}
        />
      ) : null}
      <IconButton
        icon="motion"
        size={32}
        class="cx-tool" roving
        label={toolLabel(motionName, "Space")}
        pressed={motionOn}
        onClick={() => run("motion")}
        onContextMenu={(e) => speedMenu(e.currentTarget as HTMLElement, { x: e.clientX, y: e.clientY })}
      />
      <span class="cx-tool-sep" aria-hidden="true" />
      <IconButton icon="home" size={32} class="cx-tool" roving label={toolLabel(t("tools.home"), "H")} onClick={() => run("home")} />
      <IconButton icon="immersive" size={32} class="cx-tool" roving label={toolLabel(t("tools.immersive"), "I")} onClick={() => run("immersive")} />
    </div>
  );
}
