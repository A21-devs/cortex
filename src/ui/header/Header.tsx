/**
 * Header bar, 44 px (CORTEX-UX §5.1, §2.2, §2.5): brand (glyph + "Cortex"; click → Brain, right-click → the leaf
 * menu) · scope picker · page picker · "?" Guide (P1) · Live · held arrivals · agent chip · Add sources · Settings
 * · More. At XL and L the left rail (ui/nav) carries the scope chip and the destinations, so the header has
 * neither; at M the page picker lists every destination and Live and the agent chip become icons; at S the header
 * is glyph, page picker, scope icon, More; Mini has a 32 px header with glyph, scope and More. Sample record: an
 * amber "Sample" pill after the wordmark. Owner: E11.
 */
import type { JSX } from "preact";
import { Menu } from "obsidian";
import { featureOn } from "../../shared/features";
import { openPage, openTab } from "../../state/actions";
import { railVisible } from "../breakpoints";
import { useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { openSettingsWindow } from "../openSettings";
import { Button, Glyph, IconButton } from "../primitives/buttons";
import { AgentChip } from "./AgentChip";
import { ArrivalsPill } from "./ArrivalsPill";
import { openAddSources } from "./addSources";
import { LoadingChip } from "../stage/LoadingLines";
import { LiveChip } from "./LiveChip";
import { openMoreMenu } from "./MoreMenu";
import { PageTabs } from "./PageTabs";
import { ScopePicker } from "./ScopePicker";

export function Header(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const bp = leaf.store.slices.ui.value.breakpoint;
  const mini = bp === "Mini";
  const compact = bp === "S" || mini;
  const iconChips = bp === "M";
  const onBrandMenu = (e: MouseEvent) => {
    if (!shell.bridge) return;
    e.preventDefault();
    const menu = new Menu();
    shell.bridge.fillPaneMenu(menu);
    menu.showAtMouseEvent(e);
  };
  return (
    <header class={`cx-header${mini ? " is-mini" : ""}${compact ? " is-compact" : ""}`}>
      <button
        type="button"
        class="cx-brand"
        aria-label={`${t("app.name")} · ${t("pages.brain")}`}
        title={t("pages.brain")}
        onClick={() => openTab(leaf.store, "brain")}
        onContextMenu={(e) => onBrandMenu(e as unknown as MouseEvent)}
      >
        <Glyph size={20} />
        {compact || railVisible(bp, leaf.store.slices.ui.value.immersive) ? null : <span class="cx-wordmark">{t("app.name")}</span>}
      </button>
      {s.sandbox.value && !compact ? (
        <span class="cx-sample-pill" title={t("header.sampleTip")}>
          {t("header.sample")}
        </span>
      ) : null}
      {railVisible(bp) ? null : <ScopePicker iconOnly={bp === "S"} />}
      {mini ? null : <PageTabs />}
      {featureOn("guide") && !compact ? <IconButton icon="guide" label={t("header.guide")} onClick={() => openPage(leaf.store, "guide")} /> : null}
      <span class="cx-header-spacer" />
      {compact ? null : <LoadingChip iconOnly={iconChips} />}
      {compact ? null : <LiveChip iconOnly={iconChips} />}
      {compact ? null : <ArrivalsPill />}
      {compact ? null : <AgentChip iconOnly={iconChips} />}
      {compact ? null : (
        <Button icon="addSources" class="cx-add-sources" onClick={() => void openAddSources(s, leaf.store)}>
          {t("header.addSources")}
        </Button>
      )}
      {compact ? null : <IconButton icon="settings" label={t("header.settings")} onClick={() => openCortexSettings(s.app)} />}
      <IconButton icon="more" label={t("header.more")} hasPopup="menu" onClick={(e) => openMoreMenu(s, leaf, shell, e.currentTarget as HTMLElement)} />
    </header>
  );
}

export { openAddSources };

/** Cortex's settings window (both hosts: ui/openSettings.ts). */
export function openCortexSettings(app: unknown): void {
  openSettingsWindow(app, "general");
}
