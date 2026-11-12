/**
 * Obsidian settings tab "Cortex" (CORTEX-UX §5.27–§5.30): header (glyph + "Cortex" 18/600 + version) and six
 * sections — General, Sources, Agents, Privacy (P0); Appearance (P1); Advanced (P2) — built with Obsidian's
 * `Setting` API so rows look native. Owner: E12. Must stay cheap: nothing here touches the index or the runner
 * until the user acts (buttons resolve services lazily). One key per row of shared/settings.ts; while settings
 * are corrupt the tab shows the problem and a "Use defaults" button instead of editable rows (SAFE-08).
 */
import { Notice, PluginSettingTab, Setting, setIcon, type App, type Plugin } from "obsidian";
import { CHAT_EXPORT_KEYS } from "../shared/chatExportKinds";
import { featureOn } from "../shared/features";
import type { CortexSettings, Pose, SettingsIssue } from "../shared/settings";
import { ID_COUNTRIES } from "../shared/personDetail";
import { emptyPlanViews, type PlanWindowView } from "../shared/planLimits";
import { readingText, usedText, windowName } from "../ui/planText";
import { renderAppearance } from "./settingsAppearance";
import { ALL_SECTIONS, applyLiveCapture, cloudFolderOf, liveCaptureAvailable, liveCaptureOn, resolveSettingsTarget, rovingTab, SETTINGS_WINDOW_EVENT, tabPosition, WINDOW_TABS, type SettingsSection, type WindowTab } from "../shared/settingsTabs";
import { CORTEX_ICON_ID } from "../ui/icons";
import { bucketCss, paletteById } from "../shared/palette";
import { clampAutoLock, hasPassphrase, hashPassphrase, verifyPassphrase } from "../shared/lock";
import { lockApp } from "../state/lock";
import { encryptionConfigured } from "../shared/crypto/keyring";
import { rewrapRecordKey } from "./recordKeys";
import { SETTING_RANGES } from "../shared/settings";
import { checkEndpoint, LOCAL_DEFAULT_ENDPOINT, testEndpoint, type EndpointTest } from "../shared/localModel";
import { obsidianHttp } from "./localHttp";
import { COPY, SETTINGS_COPY } from "../ui/copy";
import { renderExtraRows } from "./settingsSections";
import { whoRender } from "./settingsSections/privacySection";
import { sourceLabel } from "../ui/valueLabels";
import { isDesktopHost } from "../ui/host";
import type { CortexServices, SettingsHandle } from "./services";

export type { SettingsSection } from "../shared/settingsTabs";
/** The sections Obsidian's own Settings page lists (the old "sources" id is the Live capture tab). */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ALL_SECTIONS;

/** The icon of each window tab (Lucide names, all in Obsidian's bundled set). */
const TAB_ICONS: Record<WindowTab, string> = { general: "sliders-horizontal", appearance: "contrast", lock: "lock", capture: "circle-dot", agents: "share-2", sync: "refresh-cw" };

export interface SettingsTabHost {
  plugin: Plugin;
  settings(): SettingsHandle;
  services(): Promise<CortexServices>;
}

/** Sections visible in this build (Appearance P1, Advanced P2). */
export function visibleSections(): SettingsSection[] {
  return ALL_SECTIONS.filter((s) => (s === "appearance" ? featureOn("appearanceSettings") : s === "advanced" ? featureOn("advancedSettings") : true));
}

/** A model alias the CLI may be asked for (validated before use, shared/settings.ts). */
export const MODEL_ALIAS = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** The slider's step for a plan cap (percent). */
export const PLAN_CAP_STEP = 5;

/** True when a user-typed pattern is a valid regular expression (custom redaction patterns). */
export function validPattern(text: string): boolean {
  if (!text.trim()) return false;
  try {
    new RegExp(text);
    return true;
  } catch {
    return false;
  }
}

/** Sentence for one settings problem, from the catalogue. */
export function issueText(i: SettingsIssue): string {
  const problem = i.problem === "wrong-type" ? SETTINGS_COPY.corrupt.wrongType : i.problem === "malformed-list" ? SETTINGS_COPY.corrupt.malformedList : i.problem === "unreadable" ? SETTINGS_COPY.corrupt.unreadable : SETTINGS_COPY.corrupt.unknownValue;
  return SETTINGS_COPY.corrupt.issue.replace("{path}", i.path || SETTINGS_COPY.corrupt.whole).replace("{problem}", problem);
}

/** The pose the Settings row shows: a pose stored by an older build reads as Standing until the person chooses. */
export function shownPose(s: CortexSettings): Pose {
  return s.general.poseChosen ? s.general.pose : "standing";
}

/** The Pose row's change: sets the pose and records that the person chose it (general.poseChosen). */
export function applyPose(s: CortexSettings, pose: Pose): void {
  s.general.pose = pose;
  s.general.poseChosen = true;
}

const fill = (s: string, v: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? `{${k}}`));

/** The sentence the local model's Test button shows for an endpoint test (pure). */
export function localTestText(r: EndpointTest, address: string): string {
  const c = SETTINGS_COPY.agents;
  const some = (names: readonly string[]): string => (names.length > 6 ? `${names.slice(0, 6).join(", ")} …` : names.join(", "));
  if (r.ok) return fill(c.localTestOk, { model: r.model, s: (r.ms / 1000).toFixed(1) });
  switch (r.reason) {
    case "address":
      return c.localTestAddress;
    case "address-refused":
      return fill(c.localTestRefused, { host: r.host ?? address });
    case "unreachable":
      return fill(c.localTestUnreachable, { address });
    case "timeout":
      return c.localTestTimeout;
    case "no-model":
      return r.models.length > 0 ? fill(c.localTestNoModel, { models: some(r.models) }) : c.localTestNoModels;
    case "model-missing":
      return r.models.length > 0 ? fill(c.localTestMissing, { model: r.model ?? "that model", models: some(r.models) }) : c.localTestNoModels;
    default:
      return c.localTestNoAnswer;
  }
}

/** This computer's name for the Sync tab (Node's hostname where the host has Node, else a plain label). */
function deviceName(): string {
  try {
    const req = (window as unknown as { require?: (m: string) => { hostname?(): string } }).require;
    const name = req?.("os")?.hostname?.();
    if (name) return name;
  } catch {
    // no Node in this host
  }
  return SETTINGS_COPY.sync.unknownDevice;
}

function openFolder(path: string): void {
  try {
    const req = (window as unknown as { require?: (m: string) => { shell?: { openPath?(p: string): Promise<string> } } }).require;
    void req?.("electron")?.shell?.openPath?.(path);
  } catch {
    // opening a folder is a convenience; there is nothing to report if the shell is unavailable
  }
}

export class CortexSettingTab extends PluginSettingTab {
  section: SettingsSection = "general";
  /** The window's shown tab, and whether the "All settings" long list shows instead (Cortex Desktop's own Settings window). */
  tab: WindowTab = "general";
  all = false;
  private anchor: SettingsSection = "general";
  private bodyEl: HTMLElement | null = null;
  private animateBody = false;
  private focusTab = false;

  /**
   * `opts.modal` hosts the tab in Cortex's Settings window as an Obsidian modal (src/plugin/settingsModal.ts): the same
   * six tabs and long list Cortex Desktop draws, with `close` as the window's close button. Without it the tab is
   * Obsidian's Community plugins > Cortex page (Cortex Desktop's own Settings page frames the window itself).
   */
  constructor(app: App, private readonly host: SettingsTabHost, private readonly opts: { modal?: { close(): void }; section?: SettingsSection } = {}) {
    super(app, host.plugin);
    if (opts.modal) {
      this.showSection(opts.section, false);
      return;
    }
    // "Open settings" from a page asks for a section through the workspace event bus.
    const ws = app.workspace as unknown as { on?(name: string, cb: (section: SettingsSection) => void): unknown } | undefined;
    const ref = ws?.on?.("cortex:settings-section", (section) => {
      const target = resolveSettingsTarget(section);
      this.tab = target.tab ?? this.tab;
      this.all = target.all;
      this.anchor = target.anchor;
      this.section = target.all ? target.anchor : (target.tab ?? "general");
      this.display();
    });
    if (ref) (host.plugin as unknown as { registerEvent?(r: unknown): void }).registerEvent?.(ref);
  }

  /** Show a tab, or the long list at a section (the old Sources id is the Live capture tab). */
  showSection(id: string | undefined, render = true): void {
    const target = resolveSettingsTarget(id);
    this.tab = target.tab ?? this.tab;
    this.all = target.all;
    this.anchor = target.anchor;
    this.section = target.all ? target.anchor : (target.tab ?? "general");
    if (render) this.display();
  }

  /** The element rows are built into: the window's body, or the tab itself on Obsidian's page. */
  get mount(): HTMLElement {
    return this.bodyEl ?? this.containerEl;
  }

  /** True in Cortex Desktop (the Appearance section drops Follow theme there). */
  get desktopHost(): boolean {
    return this.branded();
  }

  private branded(): boolean {
    return (this.app as unknown as { setting?: { branded?: boolean } }).setting?.branded === true;
  }

  /** Cortex Desktop and the plugin's modal draw Cortex's own Settings window; Obsidian's page keeps its tab strip. */
  private windowed(): boolean {
    return this.opts.modal !== undefined || this.branded();
  }

  /** Close the window: the modal, or Cortex Desktop's Settings page. */
  private closeWindow(): void {
    if (this.opts.modal) this.opts.modal.close();
    else (this.app as unknown as { setting?: { close?(): void } }).setting?.close?.();
  }

  /** The latest settings update still saving (updates run in call order, so waiting for the last one waits for all). */
  private pending: Promise<unknown> = Promise.resolve();

  set(patch: (s: CortexSettings) => void): void {
    this.pending = this.host.settings().update(patch).catch(() => undefined);
  }

  /** Re-render after a change that adds or removes rows, once the change has been saved (the value only changes then). */
  refresh(): void {
    void this.pending.then(() => this.display());
  }

  services(): Promise<CortexServices> {
    return this.host.services();
  }

  override display(): void {
    const { containerEl } = this;
    const handle = this.host.settings();
    if (this.windowed() && !handle.corrupt) return this.displayWindow(handle.value);
    this.bodyEl = null;
    containerEl.empty();
    containerEl.removeClass("cx-win");
    const head = containerEl.createEl("div", { cls: "cx-settings-header" });
    head.createEl("span", { cls: "cx-settings-title", text: SETTINGS_COPY.header.title });
    head.createEl("span", { cls: "cx-settings-version", text: fill(SETTINGS_COPY.header.version, { version: this.host.plugin.manifest?.version ?? "" }) });
    if (handle.corrupt) return this.renderCorrupt(handle);
    this.openWindowRow();
    const nav = containerEl.createEl("div", { cls: "cx-settings-nav" });
    nav.setAttr("role", "tablist");
    nav.setAttr("aria-label", SETTINGS_COPY.header.sections);
    for (const id of visibleSections()) {
      const b = nav.createEl("button", { cls: id === this.section ? "cx-settings-tab is-active" : "cx-settings-tab", text: SETTINGS_COPY.sections[id] });
      b.setAttr("role", "tab");
      b.setAttr("aria-selected", String(id === this.section));
      b.addEventListener("click", () => {
        this.section = id;
        this.display();
      });
    }
    if (!(visibleSections() as string[]).includes(this.section)) this.section = "general";
    const id = resolveSettingsTarget(this.section);
    this.renderSection(id.tab ?? id.anchor, handle.value, false);
  }

  /** Obsidian's page: a button that opens Cortex's own Settings window, above the full list for people who prefer it. */
  private openWindowRow(): void {
    const w = SETTINGS_COPY.window;
    const ws = this.app.workspace as unknown as { trigger?(name: string, ...data: unknown[]): void };
    this.row(w.open, w.openDesc).addButton((b) =>
      b
        .setButtonText(w.open)
        .setCta()
        .onClick(() => {
          (this.app as unknown as { setting?: { close?(): void } }).setting?.close?.();
          ws.trigger?.(SETTINGS_WINDOW_EVENT, this.section);
        }),
    );
    this.heading(SETTINGS_COPY.window.fullList, SETTINGS_COPY.window.fullListDesc);
  }

  /** One section's rows into `mount`. `inWindow` adds the "What is sent" block to AI agents (the long list shows Privacy itself). */
  private renderSection(id: WindowTab | "privacy" | "advanced", s: CortexSettings, inWindow: boolean): void {
    this.sectionRows(id, s, inWindow);
    // Rows other features add to this tab (src/plugin/settingsSections), after the tab's own.
    renderExtraRows(this, id, s);
    if (id === "agents" && inWindow) renderExtraRows(this, "privacy", s);
  }

  private sectionRows(id: WindowTab | "privacy" | "advanced", s: CortexSettings, inWindow: boolean): void {
    switch (id) {
      case "general":
        return this.general(s);
      case "appearance":
        return renderAppearance(this, s);
      case "lock":
        return this.lockTab(s);
      case "capture":
        return this.captureSection(s);
      case "agents": {
        this.agentsSection(s);
        if (inWindow) {
          const w = SETTINGS_COPY.window;
          this.heading(w.whatIsSent, w.whatIsSentDesc);
          this.privacySection(s);
        }
        return;
      }
      case "sync":
        return this.syncSection(s);
      case "privacy":
        return this.privacySection(s);
      case "advanced":
        return this.advanced(s);
    }
  }

  // ───────────────────────────── the window (Cortex Desktop) ─────────────────────────────

  private paletteGradient(s: CortexSettings): string {
    const stops: string[] = [];
    const variant = paletteById(s.appearance.palette).forcesPaper ? "light" : "glow";
    for (let slot = 1; slot <= 6; slot++) stops.push(bucketCss("value", slot, s.appearance.palette, variant));
    return `linear-gradient(90deg, ${stops.join(", ")})`;
  }

  /** Header, six icon tabs, heading with its underline and subtitle, then the body. Re-rendered in place on every change. */
  private displayWindow(s: CortexSettings): void {
    const w = SETTINGS_COPY.window;
    const root = this.containerEl;
    const keepScroll = this.bodyEl?.scrollTop ?? 0;
    root.empty();
    root.addClass("cx-win");
    root.setAttr("style", `--cx-win-grad:${this.paletteGradient(s)}`);
    const head = root.createEl("div", { cls: "cx-win-head" });
    const brand = head.createEl("div", { cls: "cx-win-brand" });
    setIcon(brand.createEl("span", { cls: "cx-win-glyph" }), CORTEX_ICON_ID);
    brand.createEl("span", { cls: "cx-win-wordmark", text: w.wordmark });
    const meta = head.createEl("div", { cls: "cx-win-meta" });
    if (!this.all) {
      const pos = tabPosition(this.tab);
      meta.createEl("span", { cls: "cx-win-count", text: fill(w.counter, { n: pos.n, of: pos.of }) });
    }
    const link = meta.createEl("button", { cls: "cx-win-link", text: this.all ? w.backToTabs : w.allSettings });
    link.setAttr("type", "button");
    link.addEventListener("click", () => {
      this.all = !this.all;
      this.anchor = "general";
      this.animateBody = true;
      this.display();
    });
    const close = meta.createEl("button", { cls: "cx-win-close clickable-icon" });
    close.setAttr("type", "button");
    close.setAttr("aria-label", w.close);
    setIcon(close, "x");
    close.addEventListener("click", () => this.closeWindow());

    if (!this.all) {
      const strip = root.createEl("div", { cls: "cx-win-tabs" });
      strip.setAttr("role", "tablist");
      strip.setAttr("aria-label", w.tabsLabel);
      for (const id of WINDOW_TABS) {
        const on = id === this.tab;
        const b = strip.createEl("button", { cls: on ? "cx-win-tab is-active" : "cx-win-tab" });
        b.setAttr("type", "button");
        b.setAttr("role", "tab");
        b.setAttr("aria-selected", String(on));
        b.setAttr("data-tab", id);
        b.tabIndex = on ? 0 : -1;
        setIcon(b.createEl("span", { cls: "cx-win-tab-icon" }), TAB_ICONS[id]);
        b.createEl("span", { cls: "cx-win-tab-label", text: w.tabs[id].label });
        b.addEventListener("click", () => this.selectTab(id));
        b.addEventListener("keydown", (e) => {
          const next = rovingTab(id, e.key);
          if (!next) return;
          e.preventDefault();
          this.focusTab = true;
          this.selectTab(next);
        });
      }
    }
    const titleBlock = root.createEl("div", { cls: "cx-win-title" });
    const text = this.all ? { title: w.allTitle, sub: w.allSub } : w.tabs[this.tab];
    titleBlock.createEl("h2", { text: text.title });
    titleBlock.createEl("span", { cls: "cx-win-rule" }).setAttr("aria-hidden", "true");
    titleBlock.createEl("p", { cls: "cx-win-sub", text: text.sub });

    const body = root.createEl("div", { cls: this.animateBody ? "cx-win-body is-entering" : "cx-win-body" });
    this.animateBody = false;
    body.setAttr("role", "tabpanel");
    this.bodyEl = body;
    if (this.all) this.renderAll(s, body);
    else this.renderSection(this.tab, s, true);
    this.bodyEl = body;
    if (this.focusTab) {
      this.focusTab = false;
      root.querySelector<HTMLElement>(".cx-win-tab.is-active")?.focus();
    }
    body.scrollTop = keepScroll;
  }

  private selectTab(id: WindowTab): void {
    if (id === this.tab && !this.all) return;
    this.tab = id;
    this.all = false;
    this.section = id;
    this.animateBody = true;
    // A tab opens at its top, not where the last tab was scrolled to.
    if (this.bodyEl) this.bodyEl.scrollTop = 0;
    this.display();
  }

  /** The long list: every section under its own heading, then the desktop's own rows when the host has them. */
  private renderAll(s: CortexSettings, body: HTMLElement): void {
    const w = SETTINGS_COPY.window;
    for (const id of ALL_SECTIONS) {
      if ((id === "appearance" && !featureOn("appearanceSettings")) || (id === "advanced" && !featureOn("advancedSettings"))) continue;
      const sec = body.createEl("section", { cls: "cx-win-section" });
      sec.setAttr("data-section", id);
      const copy = id === "privacy" ? w.privacy : id === "advanced" ? w.advanced : w.tabs[id];
      sec.createEl("h3", { text: copy.title });
      sec.createEl("p", { cls: "cx-win-sub", text: copy.sub });
      this.bodyEl = sec;
      this.renderSection(id, s, false);
    }
    this.bodyEl = body;
    const extras = (this.app as unknown as { setting?: { extraTabs?(): { id: string; containerEl: HTMLElement; display(): void }[] } }).setting?.extraTabs?.() ?? [];
    for (const t of extras) {
      const sec = body.createEl("section", { cls: "cx-win-section" });
      sec.createEl("h3", { text: w.thisApp });
      sec.appendChild(t.containerEl);
      t.display();
    }
    const target = body.querySelector<HTMLElement>(`[data-section="${this.anchor}"]`);
    if (target && this.anchor !== "general") window.setTimeout(() => target.scrollIntoView?.({ block: "start" }), 0);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  row(name: string, desc?: string): Setting {
    const r = new Setting(this.mount).setName(name);
    if (desc) r.setDesc(desc);
    return r;
  }

  heading(name: string, desc?: string): void {
    const r = new Setting(this.mount).setName(name).setHeading();
    if (desc) r.setDesc(desc);
  }

  toggle(name: string, desc: string | undefined, value: boolean, apply: (s: CortexSettings, v: boolean) => void, disabled = false): void {
    this.row(name, desc).addToggle((tg) => tg.setValue(value).setDisabled(disabled).onChange((v) => this.set((x) => apply(x, v))));
  }

  dropdown<V extends string>(name: string, desc: string | undefined, options: Record<V, string>, value: V, apply: (s: CortexSettings, v: V) => void, rerender = false): void {
    this.row(name, desc).addDropdown((d) =>
      d
        .addOptions(options)
        .setValue(value)
        .onChange((v) => {
          this.set((x) => apply(x, v as V));
          if (rerender) this.refresh();
        }),
    );
  }

  text(name: string, desc: string | undefined, value: string, placeholder: string, apply: (s: CortexSettings, v: string) => void): void {
    this.row(name, desc).addText((tx) => tx.setValue(value).setPlaceholder(placeholder).onChange((v) => this.set((x) => apply(x, v.trim()))));
  }

  slider(name: string, desc: string | undefined, range: readonly [number, number], step: number, value: number, apply: (s: CortexSettings, v: number) => void): void {
    this.row(name, desc).addSlider((sl) => sl.setLimits(range[0], range[1], step).setValue(value).setDynamicTooltip().onChange((v) => this.set((x) => apply(x, v))));
  }

  /** A list of strings: one row per item with Remove, then an add row. */
  list(name: string, desc: string | undefined, items: readonly string[], placeholder: string, add: (s: CortexSettings, v: string) => void, remove: (s: CortexSettings, i: number) => void, validate: (v: string) => string | null = () => null): void {
    this.heading(name, desc);
    items.forEach((item, i) => {
      this.row(item).addExtraButton((b) =>
        b.setIcon?.("x")?.setTooltip?.(SETTINGS_COPY.sources.remove)?.onClick(() => {
          this.set((x) => remove(x, i));
          this.refresh();
        }),
      );
    });
    let draft = "";
    const commit = () => {
      const v = draft.trim();
      if (!v) return;
      const problem = validate(v);
      if (problem) return this.notify(problem);
      this.set((x) => add(x, v));
      this.refresh();
    };
    this.row(SETTINGS_COPY.sources.add)
      .addText((tx) => tx.setPlaceholder(placeholder).onChange((v) => (draft = v)))
      .addButton((b) => b.setButtonText(SETTINGS_COPY.sources.add).onClick(commit));
  }

  /**
   * The two plan caps: for each window a switch, a slider (the share of the window agents stop at) and a meter showing the
   * plan's use as Claude Code last reported it, with the reset time. The reading arrives once the services are up.
   */
  private planRows(a: CortexSettings["agents"]): void {
    const c = SETTINGS_COPY.agents;
    this.heading(c.planCaps, c.planCapsDesc);
    for (const id of ["fiveHour", "weekly"] as const) {
      const state = { on: a.planCaps[id].on, pct: a.planCaps[id].pct };
      let view: PlanWindowView = emptyPlanViews()[id];
      const row = this.row(id === "fiveHour" ? c.fiveCap : c.weekCap);
      const bar = row.descEl.createEl("div", { cls: "cx-meter cx-plan-bar", attr: { role: "meter", "aria-valuemin": "0", "aria-valuemax": "100" } });
      const usedEl = bar.createEl("span");
      const mark = bar.createEl("i", { cls: "cx-plan-mark" });
      const text = row.descEl.createEl("div", { cls: "cx-plan-line" });
      const paint = (): void => {
        const used = view.pct === null ? 0 : Math.min(100, view.pct);
        usedEl.setAttr("style", `width: ${used}%`);
        mark.setAttr("style", state.on ? `left: ${state.pct}%` : "display: none");
        bar.setAttr("aria-valuenow", String(Math.round(used)));
        bar.setAttr("aria-label", `${windowName(id)}: ${usedText(view)}`);
        const reading = readingText(view);
        text.setText(state.on ? fill(c.capPctDesc, { pct: state.pct, reading }) : fill(c.capOffDesc, { reading }));
      };
      paint();
      void this.services()
        .then((svc) => {
          view = svc.shared.slices.activity.peek().plan[id];
          paint();
        })
        .catch(() => undefined);
      row
        .addToggle((tg) =>
          tg.setValue(state.on).onChange((v) => {
            state.on = v;
            this.set((x) => void (x.agents.planCaps[id].on = v));
            paint();
          }),
        )
        .addSlider((sl) =>
          sl.setLimits(SETTING_RANGES.planCapPct[0], SETTING_RANGES.planCapPct[1], PLAN_CAP_STEP).setValue(state.pct).setDynamicTooltip().onChange((v) => {
            state.pct = Math.round(v);
            this.set((x) => void (x.agents.planCaps[id].pct = Math.round(v)));
            paint();
          }),
        );
    }
  }

  /** "‹n› blocks sealed · last ‹date›" and the explicit public timestamp (CORTEX-UX 5.27 Date seals). */
  private renderSeals(): void {
    const c = SETTINGS_COPY.advanced;
    const row = this.row(c.sealedNone);
    const show = (text: string): void => void row.setName(text);
    void this.services()
      .then((svc) => svc.runner.request({ cmd: "seals.status", args: {} }))
      .then((st) => {
        if (st.blocks === 0 || !st.lastAt) return;
        const date = new Date(st.lastAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
        show(fill(st.intact ? c.sealed : c.sealedBroken, { n: st.blocks, date }));
      })
      .catch(() => undefined);
    row.addButton((b) =>
      b.setButtonText(c.timestamp).onClick(async () => {
        const { confirm } = await import("../ui/modals/ConfirmModal");
        if (!(await confirm(this.app, { title: c.timestampConfirm, body: c.timestampWhat, confirm: c.timestampSend, cancel: COPY.dialogs.cancel }))) return;
        b.setButtonText(c.timestamping);
        try {
          const r = await (await this.services()).runner.request({ cmd: "seals.publish", args: {} });
          const date = new Date(r.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
          this.notify(fill(r.already ? c.timestampedAlready : c.timestamped, { n: r.n, date }));
        } catch (e) {
          this.notify((e as { detail?: { reason?: string } })?.detail?.reason === "no-seals" ? c.timestampNone : c.timestampFailed);
        } finally {
          b.setButtonText(c.timestamp);
        }
      }),
    );
  }

  /** "Check public timestamps" and the weekly standing consent (both ask first and say exactly what leaves). */
  private renderStampChecks(): void {
    const c = SETTINGS_COPY.advanced;
    const adv = this.host.settings().value.advanced;
    this.row(c.checkStamps, c.checkStampsDesc).addButton((b) =>
      b.setButtonText(c.checkNow).onClick(async () => {
        const { confirm } = await import("../ui/modals/ConfirmModal");
        if (!(await confirm(this.app, { title: COPY.you.checkConfirm, body: COPY.you.checkWhat, confirm: COPY.you.checkSend, cancel: COPY.dialogs.cancel }))) return;
        b.setButtonText(COPY.you.checking);
        try {
          const r = await (await this.services()).runner.request({ cmd: "seals.check", args: {} });
          this.notify(r.confirmed > 0 && r.height !== undefined ? fill(COPY.you.checkDone, { height: r.height }) : r.checked === 0 && r.pending === 0 ? COPY.you.checkNone : r.failed > 0 || r.unreachable ? COPY.you.checkFailed : COPY.you.checkWaiting);
        } catch {
          this.notify(COPY.you.checkFailed);
        } finally {
          b.setButtonText(c.checkNow);
        }
      }),
    );
    this.row(c.weekly, c.weeklyDesc).addToggle((tg) =>
      tg.setValue(adv.dateSeals.weeklyStamp).onChange(async (v) => {
        if (v) {
          const { confirm } = await import("../ui/modals/ConfirmModal");
          if (!(await confirm(this.app, { title: c.weeklyConfirm, body: c.timestampWhat, confirm: c.timestampSend, cancel: COPY.dialogs.cancel }))) {
            tg.setValue(false);
            return;
          }
        }
        await this.host.settings().update((x) => void (x.advanced.dateSeals.weeklyStamp = v));
        this.notify(v ? c.weeklyOn : c.weeklyOff);
      }),
    );
  }

  notify(text: string): void {
    new Notice(text);
  }

  private renderCorrupt(handle: SettingsHandle): void {
    new Setting(this.mount).setName(SETTINGS_COPY.corrupt.name).setDesc(SETTINGS_COPY.corrupt.desc);
    for (const i of handle.issues ?? []) new Setting(this.mount).setName(issueText(i));
    this.mount.createEl("p", { cls: "cx-note", text: SETTINGS_COPY.corrupt.kept });
    this.row(SETTINGS_COPY.corrupt.useDefaults).addButton((b) =>
      b
        .setButtonText(SETTINGS_COPY.corrupt.useDefaults)
        .setCta()
        .onClick(async () => {
          try {
            await (handle as SettingsHandle & { useDefaults(): Promise<void> }).useDefaults();
            this.display();
          } catch {
            this.notify(SETTINGS_COPY.corrupt.failed);
          }
        }),
    );
  }

  // ───────────────────────────── General ─────────────────────────────

  private general(s: CortexSettings): void {
    const g = SETTINGS_COPY.general;
    this.toggle(g.openOnStartup, g.openOnStartupDesc, s.general.openOnStartup, (x, v) => void (x.general.openOnStartup = v));
    this.dropdown(g.pose, g.poseDesc, { lying: g.lying, standing: g.standing }, shownPose(s), applyPose);
    this.toggle(g.followActiveNote, g.followActiveNoteDesc, s.general.followActiveNote, (x, v) => void (x.general.followActiveNote = v));
    this.toggle(g.showReference, g.showReferenceDesc, s.general.showReference, (x, v) => void (x.general.showReference = v));
    this.dropdown(g.dateFormat, undefined, { "d MMM yyyy": "4 Nov 2026", "yyyy-MM-dd": "2026-11-04", "MMM d, yyyy": "Nov 4, 2026" }, s.general.dateFormat, (x, v) => void (x.general.dateFormat = v));
    this.dropdown(g.weekStart, undefined, { "1": g.monday, "0": g.sunday }, String(s.general.weekStart) as "0" | "1", (x, v) => void (x.general.weekStart = v === "0" ? 0 : 1));
    this.row(g.resetDisplay, g.resetDisplayDesc).addButton((b) =>
      b.setButtonText(g.reset).onClick(async () => {
        try {
          const [{ VIEW_TYPE_CORTEX }, { resetDisplay }, { defaultView }] = await Promise.all([import("../ui/CortexView"), import("../state/actions"), import("../state/types")]);
          let n = 0;
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CORTEX)) {
            const store = (leaf.view as unknown as { leafStore?(): Parameters<typeof resetDisplay>[0] | null }).leafStore?.();
            if (!store) continue;
            resetDisplay(store, defaultView(this.host.settings().value));
            n += 1;
          }
          this.notify(fill(g.resetDone, { n }));
        } catch {
          this.notify(SETTINGS_COPY.advanced.failed);
        }
      }),
    );
  }

  // ───────────────────────────── Sources ─────────────────────────────

  private sourcesSection(s: CortexSettings): void {
    const c = SETTINGS_COPY.sources;
    const src = s.sources;
    this.toggle(c.autoRefresh, c.autoRefreshDesc, src.autoRefresh, (x, v) => void (x.sources.autoRefresh = v));
    this.toggle(c.exportReminders, c.exportRemindersDesc, src.exportReminders.notify, (x, v) => void (x.sources.exportReminders.notify = v));
    this.mount.createEl("p", { cls: "cx-note", text: c.storage });
    this.row(COPY.sources.addSources).addButton((b) => b.setButtonText(c.addSources).onClick(() => (this.app as unknown as { commands?: { executeCommandById?(id: string): boolean } }).commands?.executeCommandById?.("cortex:add-sources")));

    this.heading(c.vault, c.vaultDesc);
    this.toggle(c.enabled, undefined, src.vault.enabled, (x, v) => void (x.sources.vault.enabled = v));
    this.toggle(c.includeReference, c.includeReferenceDesc, s.general.showReference, (x, v) => void (x.general.showReference = v));
    this.list(c.skipFolders, c.skipFoldersDesc, src.vault.excludeFolders, c.folderPlaceholder, (x, v) => void x.sources.vault.excludeFolders.push(v), (x, i) => void x.sources.vault.excludeFolders.splice(i, 1));

    this.heading(c.raw, c.rawDesc);
    this.toggle(c.enabled, undefined, src.raw.enabled, (x, v) => void (x.sources.raw.enabled = v));
    this.toggle(c.skipYaml, undefined, src.raw.skipYaml, (x, v) => void (x.sources.raw.skipYaml = v));
    this.toggle(c.skipApiDump, undefined, src.raw.skipApiDump, (x, v) => void (x.sources.raw.skipApiDump = v));
    this.list(c.rawReference, undefined, src.raw.referenceFolders, c.folderPlaceholder, (x, v) => void x.sources.raw.referenceFolders.push(v), (x, i) => void x.sources.raw.referenceFolders.splice(i, 1));
    this.list(c.skipFolders, undefined, src.raw.excludeFolders, c.folderPlaceholder, (x, v) => void x.sources.raw.excludeFolders.push(v), (x, i) => void x.sources.raw.excludeFolders.splice(i, 1));

    this.heading(c.claudeCode, c.claudeCodeDesc);
    this.toggle(c.enabled, undefined, src.claudeCode.enabled, (x, v) => void (x.sources.claudeCode.enabled = v));
    this.text(c.projectsDir, c.projectsDirDesc, src.claudeCode.projectsDir, "", (x, v) => void (x.sources.claudeCode.projectsDir = v));
    this.toggle(c.watch, undefined, src.claudeCode.watch, (x, v) => void (x.sources.claudeCode.watch = v));
    this.toggle(c.subagents, undefined, src.claudeCode.includeSubagents, (x, v) => void (x.sources.claudeCode.includeSubagents = v));
    this.toggle(c.toolOutput, undefined, src.claudeCode.includeToolOutput, (x, v) => void (x.sources.claudeCode.includeToolOutput = v));
    this.toggle(c.thinking, undefined, src.claudeCode.includeThinking, (x, v) => void (x.sources.claudeCode.includeThinking = v));
    this.mount.createEl("p", { cls: "cx-note", text: c.sessionsNote });
    this.heading(c.projectAreas, c.projectAreasDesc);
    for (const [project, area] of Object.entries(src.claudeCode.spaceMap)) {
      this.row(project, fill(c.folderRow, { label: c.area, path: area })).addExtraButton((b) =>
        b.setIcon?.("x")?.setTooltip?.(c.remove)?.onClick(() => {
          this.set((x) => void delete x.sources.claudeCode.spaceMap[project]);
          this.refresh();
        }),
      );
    }
    this.list(c.excludedProjects, undefined, src.claudeCode.excludeProjects, c.projectPlaceholder, (x, v) => void x.sources.claudeCode.excludeProjects.push(v), (x, i) => void x.sources.claudeCode.excludeProjects.splice(i, 1));

    this.heading(c.claudeAi);
    this.toggle(c.enabled, undefined, src.claudeAi.enabled, (x, v) => void (x.sources.claudeAi.enabled = v));
    this.toggle(c.attachments, undefined, src.claudeAi.includeAttachments, (x, v) => void (x.sources.claudeAi.includeAttachments = v));
    this.toggle(c.keepCopy, c.keepCopyDesc, src.claudeAi.keepExportCopy, (x, v) => void (x.sources.claudeAi.keepExportCopy = v));

    this.heading(c.chatgpt);
    this.toggle(c.enabled, undefined, src.chatgpt.enabled, (x, v) => void (x.sources.chatgpt.enabled = v));
    this.toggle(c.toolOutput, undefined, src.chatgpt.includeToolOutput, (x, v) => void (x.sources.chatgpt.includeToolOutput = v));
    this.toggle(c.thinking, undefined, src.chatgpt.includeThinking, (x, v) => void (x.sources.chatgpt.includeThinking = v));
    this.toggle(c.keepCopy, c.keepCopyDesc, src.chatgpt.keepExportCopy, (x, v) => void (x.sources.chatgpt.keepExportCopy = v));

    this.heading(c.gemini);
    this.toggle(c.enabled, undefined, src.gemini.enabled, (x, v) => void (x.sources.gemini.enabled = v));
    this.slider(c.gap, c.gapDesc, [1, 120], 1, src.gemini.gapMinutes, (x, v) => void (x.sources.gemini.gapMinutes = v));
    this.toggle(c.keepCopy, c.keepCopyDesc, src.gemini.keepExportCopy, (x, v) => void (x.sources.gemini.keepExportCopy = v));

    this.heading(c.notion);
    this.toggle(c.enabled, undefined, src.notion.enabled, (x, v) => void (x.sources.notion.enabled = v));
    this.heading(c.googleDocs);
    this.toggle(c.enabled, undefined, src.googleDocs.enabled, (x, v) => void (x.sources.googleDocs.enabled = v));
    for (const key of CHAT_EXPORT_KEYS) {
      this.heading(c[key]);
      this.toggle(c.enabled, undefined, src.chatExports[key].enabled, (x, v) => void (x.sources.chatExports[key].enabled = v));
    }

    const agents = [
      [c.codexCli, "codexCli"],
      [c.geminiCli, "geminiCli"],
      [c.cursor, "cursor"],
    ] as const;
    agents.forEach(([label, key], i) => {
      this.heading(label, i === 0 ? c.agentsNote : undefined);
      this.toggle(c.enabled, undefined, src[key].enabled, (x, v) => void (x.sources[key].enabled = v));
      this.text(c.agentDir, c.agentDirDesc, src[key].dir, "", (x, v) => void (x.sources[key].dir = v));
      this.toggle(c.watch, undefined, src[key].watch, (x, v) => void (x.sources[key].watch = v));
      this.toggle(c.toolOutput, undefined, src[key].includeToolOutput, (x, v) => void (x.sources[key].includeToolOutput = v));
    });

    this.heading(c.folders);
    if (src.folders.length === 0) this.mount.createEl("p", { cls: "cx-note", text: c.noFolders });
    src.folders.forEach((f, i) => {
      this.row(fill(c.folderRow, { label: f.label, path: f.path }))
        .addToggle((tg) => tg.setValue(f.enabled).onChange((v) => this.set((x) => void (x.sources.folders[i]!.enabled = v))))
        .addExtraButton((b) =>
          b.setIcon?.("x")?.setTooltip?.(c.remove)?.onClick(() => {
            this.set((x) => void x.sources.folders.splice(i, 1));
            this.refresh();
          }),
        );
      this.toggle(c.watchFolder, undefined, f.watch, (x, v) => void (x.sources.folders[i]!.watch = v));
    });

    this.heading(c.written, c.writtenDesc);
    this.toggle(c.enabled, undefined, src.written.enabled, (x, v) => void (x.sources.written.enabled = v));
  }

  // ───────────────────────────── Agents ─────────────────────────────

  private agentsSection(s: CortexSettings): void {
    const c = SETTINGS_COPY.agents;
    const a = s.agents;
    this.toggle(c.organise, c.organiseDesc, a.enabled, (x, v) => void (x.agents.enabled = v));
    this.dropdown(c.engine, a.engine === "none" ? c.engineNoneDesc : undefined, { "claude-cli": c.engineCli, "codex-cli": c.engineCodex, "anthropic-api": c.engineApi, local: c.engineLocal, none: c.engineNone }, a.engine, (x, v) => void (x.agents.engine = v), true);
    if (a.engine === "local") this.localRows(a.local);
    else if (a.engine === "codex-cli") this.codexRows(a);
    else if (a.engine !== "none") this.claudeRows(a);
    if (a.engine !== "local" && a.engine !== "codex-cli" && a.engine !== "none") {
      this.heading(c.models, c.modelsDesc);
      for (const [role, label] of [["labels", c.labels], ["summaries", c.summaries], ["maps", c.maps], ["ask", c.ask]] as const) {
        this.row(label).addText((tx) =>
          tx.setValue(a.models[role]).onChange((v) => {
            const alias = v.trim();
            if (MODEL_ALIAS.test(alias)) this.set((x) => void (x.agents.models[role] = alias));
          }),
        );
      }
    }
    // The caps measure the Claude plan: they mean nothing for the rules or for Codex.
    if (a.engine !== "none" && a.engine !== "codex-cli") this.planRows(a);
    this.toggle(c.askCounts, c.askCountsDesc, a.askCountsTowardCap, (x, v) => void (x.agents.askCountsTowardCap = v));
    this.toggle(c.applyAsk, c.applyAskDesc, a.applyAskWithoutConfirm, (x, v) => void (x.agents.applyAskWithoutConfirm = v));
    this.toggle(c.idle, c.idleDesc, a.onlyWhenIdle, (x, v) => void (x.agents.onlyWhenIdle = v));
    this.toggle(c.nightly, c.nightlyDesc, a.nightly.enabled, (x, v) => void (x.agents.nightly.enabled = v));
    this.slider(c.concurrency, undefined, SETTING_RANGES.concurrency, 1, a.concurrency, (x, v) => void (x.agents.concurrency = v));

    this.heading(c.packs);
    for (const [pack, label] of [["session", c.session], ["placement", c.placement], ["resume", c.resumePack]] as const) {
      const on = a.enabledPacks[pack] !== undefined && a.enabledPacks[pack] !== "off";
      this.row(label, fill(c.packVersion, { version: on ? a.enabledPacks[pack]! : "off" })).addToggle((tg) =>
        tg.setValue(on).onChange((v) => this.set((x) => void (x.agents.enabledPacks[pack] = v ? "1.0.0" : "off"))),
      );
    }
    this.row(c.para, c.paraNone).setDisabled(true);
    this.row(c.fixes, c.alwaysOn);
    this.dropdown(c.afterLabelling, undefined, { apply: c.applyAndCheck, hold: c.holdForCheck }, a.reviewMode, (x, v) => void (x.agents.reviewMode = v));
    this.toggle(c.skipReference, c.skipReferenceDesc, a.skipReference, (x, v) => void (x.agents.skipReference = v));
    this.row(c.runNow).addButton((b) =>
      b.setButtonText(c.runNow).onClick(async () => {
        try {
          (await this.services()).clock.poke("manual");
          this.notify(c.started);
        } catch {
          this.notify(SETTINGS_COPY.advanced.failed);
        }
      }),
    );
    this.row(a.paused ? c.resume : c.pause).addButton((b) =>
      b.setButtonText(a.paused ? c.resume : c.pause).onClick(() => {
        this.set((x) => void (x.agents.paused = !a.paused));
        this.refresh();
      }),
    );
  }

  /** The Claude Code rows of the Agents section (path and Test). */
  /** The rows for the person's own Codex CLI: where it is, which model, and where the text goes. */
  private codexRows(a: CortexSettings["agents"]): void {
    const c = SETTINGS_COPY.agents;
    this.row(c.codexPath, c.codexPathDesc).addText((tx) => tx.setValue(a.codex.path).setPlaceholder("").onChange((v) => this.set((x) => void (x.agents.codex.path = v.trim()))));
    this.row(c.codexModel, c.codexModelDesc).addText((tx) =>
      tx.setValue(a.codex.model).setPlaceholder("").onChange((v) => {
        const name = v.trim();
        if (name === "" || MODEL_ALIAS.test(name)) this.set((x) => void (x.agents.codex.model = name));
      }),
    );
    this.row(c.codexNote);
  }

  private claudeRows(a: CortexSettings["agents"]): void {
    const c = SETTINGS_COPY.agents;
    let testButton: { setButtonText(t: string): unknown } | null = null;
    this.row(c.claudePath, c.claudePathDesc)
      .addText((tx) => tx.setValue(a.claudePath).setPlaceholder("").onChange((v) => this.set((x) => void (x.agents.claudePath = v.trim()))))
      .addButton((b) => {
        testButton = b;
        b.setButtonText(c.test).onClick(async () => {
          testButton?.setButtonText(c.testing);
          try {
            const started = Date.now();
            const svc = await this.services();
            const res = await svc.runner.request({ cmd: "doctor", args: { live: true } });
            this.notify(res.claude.version ? fill(c.testOk, { version: res.claude.version, s: ((Date.now() - started) / 1000).toFixed(1) }) : c.testFailed);
          } catch {
            this.notify(c.testFailed);
          } finally {
            testButton?.setButtonText(c.test);
          }
        });
      });
  }

  /** The rows for a model on this computer: address, server type, model, network switch, timeout, cap, Test. */
  private localRows(l: CortexSettings["agents"]["local"]): void {
    const c = SETTINGS_COPY.agents;
    this.row(c.localAddress, c.localAddressDesc).addText((tx) =>
      tx.setValue(l.endpoint).setPlaceholder(LOCAL_DEFAULT_ENDPOINT).onChange((v) => {
        const value = v.trim();
        const ok = checkEndpoint(value, l.allowNetwork);
        if (!ok.ok && ok.reason === "not-loopback") this.notify(c.localRefusedNotice);
        this.set((x) => void (x.agents.local.endpoint = value));
      }),
    );
    this.dropdown(c.localType, undefined, { ollama: c.localTypeOllama, openai: c.localTypeOpenai }, l.api, (x, v) => void (x.agents.local.api = v));
    this.row(c.localModel, c.localModelDesc).addText((tx) => tx.setValue(l.model).setPlaceholder("qwen2.5:14b").onChange((v) => this.set((x) => void (x.agents.local.model = v.trim()))));
    this.toggle(c.localNetwork, c.localNetworkDesc, l.allowNetwork, (x, v) => void (x.agents.local.allowNetwork = v));
    this.row(c.localSeconds, c.localSecondsDesc).addText((tx) =>
      tx.setValue(String(l.timeoutSec)).onChange((v) => {
        const n = Number(v.trim());
        if (Number.isFinite(n) && n >= SETTING_RANGES.localTimeoutSec[0] && n <= SETTING_RANGES.localTimeoutSec[1]) this.set((x) => void (x.agents.local.timeoutSec = Math.round(n)));
      }),
    );
    this.toggle(c.localCount, c.localCountDesc, l.countTowardCap, (x, v) => void (x.agents.local.countTowardCap = v));
    let testButton: { setButtonText(t: string): unknown } | null = null;
    this.row(c.test).addButton((b) => {
      testButton = b;
      b.setButtonText(c.test).onClick(async () => {
        testButton?.setButtonText(c.testing);
        try {
          const cur = this.host.settings().value.agents.local;
          this.notify(localTestText(await testEndpoint({ ...cur, http: obsidianHttp }), cur.endpoint));
        } catch {
          this.notify(fill(c.localTestUnreachable, { address: l.endpoint }));
        } finally {
          testButton?.setButtonText(c.test);
        }
      });
    });
  }

  // ───────────────────────────── Privacy ─────────────────────────────

  /** Move to another tab of the window, for the "Who can read this" buttons. */
  goTo(tab: string): void {
    if ((WINDOW_TABS as readonly string[]).includes(tab)) this.selectTab(tab as WindowTab);
  }

  private privacySection(s: CortexSettings): void {
    const c = SETTINGS_COPY.privacy;
    whoRender(this, s);
    this.list(c.names, c.namesDesc, [...s.you.names, ...s.you.handles], c.namesPlaceholder, (x, v) => void (v.startsWith("@") ? x.you.handles.push(v) : x.you.names.push(v)), (x, i) => (i < x.you.names.length ? void x.you.names.splice(i, 1) : void x.you.handles.splice(i - x.you.names.length, 1)));
    this.row(c.namesCheck).addButton((b) =>
      b.setButtonText(c.namesCheck).onClick(async () => {
        try {
          await (await this.services()).runner.request({ cmd: "agents.run", args: { reason: "manual", jobs: ["name-check"] } });
          this.notify(c.namesStarted);
        } catch {
          this.notify(SETTINGS_COPY.advanced.failed);
        }
      }),
    );
    const speakerSources = [...Object.keys(s.you.speakerBySource), ...(s.sources.claudeAi.enabled ? ["claude-ai"] : []), ...(s.sources.chatgpt.enabled ? ["chatgpt"] : []), ...(s.sources.gemini.enabled ? ["gemini"] : [])].filter((v, i, all) => all.indexOf(v) === i);
    this.heading(c.speaker, speakerSources.length === 0 ? c.noSpeakerSources : c.speakerDesc);
    for (const id of speakerSources) {
      this.dropdown(id, undefined, { you: c.speakerYou, other: c.speakerOther, ask: c.speakerAsk }, s.you.speakerBySource[id] ?? "ask", (x, v) => void (x.you.speakerBySource[id] = v));
    }
    this.list(c.offLimits, c.offLimitsDesc, s.privacy.offLimits.map((r) => r.path), c.offLimitsPlaceholder, (x, v) => void x.privacy.offLimits.push({ path: v, reason: "" }), (x, i) => void x.privacy.offLimits.splice(i, 1));
    this.heading(c.leftOut, c.leftOutDesc);
    this.row(c.leftOut).addButton((b) => b.setButtonText(c.leftOutShow).onClick(() => (this.app as unknown as { commands?: { executeCommandById?(id: string): boolean } }).commands?.executeCommandById?.("cortex:open-sources")));

    this.heading(c.withhold, c.withholdDesc);
    for (const [kind, label] of [["chatgpt", sourceLabel("chatgpt")], ["gemini", sourceLabel("gemini")], ["claude-ai", sourceLabel("claude-ai")]] as const) {
      this.toggle(label, undefined, s.privacy.withholdAssistantFrom[kind] ?? false, (x, v) => void (x.privacy.withholdAssistantFrom[kind] = v));
    }
    this.heading(c.redact);
    this.toggle(c.secrets, undefined, s.privacy.redact.secrets, (x, v) => void (x.privacy.redact.secrets = v));
    this.toggle(c.emails, undefined, s.privacy.redact.emails, (x, v) => void (x.privacy.redact.emails = v));
    this.toggle(c.phones, undefined, s.privacy.redact.phones, (x, v) => void (x.privacy.redact.phones = v));
    this.toggle(c.personal, c.personalDesc, s.privacy.redact.personal, (x, v) => void (x.privacy.redact.personal = v));
    this.heading(c.idCountries);
    for (const id of ID_COUNTRIES) {
      this.toggle(c.idCountryNames[id] ?? id, undefined, s.privacy.screening.idCountries.includes(id), (x, v) => void (x.privacy.screening.idCountries = v ? [...new Set([...x.privacy.screening.idCountries, id])] : x.privacy.screening.idCountries.filter((k) => k !== id)));
    }
    this.list(c.screenNames, c.screenNamesDesc, s.privacy.screening.names, c.screenNamesPlaceholder, (x, v) => void x.privacy.screening.names.push(v), (x, i) => void x.privacy.screening.names.splice(i, 1));
    this.toggle(c.localNames, c.localNamesDesc, s.privacy.screening.localNames, (x, v) => void (x.privacy.screening.localNames = v));
    this.list(c.custom, c.customDesc, s.privacy.redact.custom, c.patternPlaceholder, (x, v) => void x.privacy.redact.custom.push(v), (x, i) => void x.privacy.redact.custom.splice(i, 1), (v) => (validPattern(v) ? null : c.patternInvalid));
    this.toggle(c.keepSecretsLocal, c.keepSecretsLocalDesc, s.privacy.keepSecretsLocal, (x, v) => void (x.privacy.keepSecretsLocal = v));
    this.dropdown(c.accessLog, undefined, { forever: c.forever, "1y": c.year, "90d": c.days90 }, s.privacy.accessLogRetention, (x, v) => void (x.privacy.accessLogRetention = v));
    this.row(c.clearCache, c.clearCacheDesc).addButton((b) =>
      b
        .setButtonText(c.clear)
        .setWarning()
        .onClick(async () => {
          const { confirm } = await import("../ui/modals/ConfirmModal");
          if (!(await confirm(this.app, { title: c.clearConfirm, confirm: c.clear, cancel: COPY.dialogs.cancel, warning: true }))) return;
          try {
            const res = await (await this.services()).runner.request({ cmd: "cache.clear", args: {} });
            this.notify(fill(c.cleared, { n: res.files }));
          } catch {
            this.notify(SETTINGS_COPY.advanced.failed);
          }
        }),
    );
  }

  /** Settings > Privacy > Lock: the passphrase (kept as a salted hash), the idle auto-lock and Lock now. */
  private lockSection(s: CortexSettings, withHeading = true): void {
    const c = SETTINGS_COPY.privacy;
    const lock = s.privacy.lock;
    const isSet = hasPassphrase(lock);
    if (withHeading) this.heading(c.lock, c.lockDesc);
    this.row(c.lockPassphrase, `${isSet ? c.lockIsSet : c.lockNotSet} ${c.lockPassphraseDesc}`);
    let current = "";
    let next = "";
    if (isSet) {
      this.row(c.lockCurrent).addText((tx) => {
        tx.inputEl?.setAttribute?.("type", "password");
        tx.onChange((v) => (current = v));
      });
    }
    this.row(isSet ? c.lockChange : c.lockSet)
      .addText((tx) => {
        tx.inputEl?.setAttribute?.("type", "password");
        tx.setPlaceholder(c.lockPlaceholder).onChange((v) => (next = v));
      })
      .addButton((b) =>
        b.setButtonText(isSet ? c.lockChange : c.lockSet).onClick(async () => {
          if (next.length < 4) return this.notify(c.lockTooShort);
          if (isSet && !(await verifyPassphrase(current, lock))) return this.notify(c.lockWrong);
          // An encrypted record: the passphrase also wraps the key, so the key is wrapped again under the new one first.
          if (encryptionConfigured()) {
            if (next.length < 8) return this.notify(SETTINGS_COPY.lock.enc.weak);
            const keys = (await this.services()).recordKeys;
            if (!keys || !(await rewrapRecordKey(keys, current, next))) return this.notify(c.lockWrong);
          }
          try {
            const rec = await hashPassphrase(next);
            await this.host.settings().update((x) => void (x.privacy.lock = { ...x.privacy.lock, ...rec }));
            this.notify(c.lockSaved);
            this.refresh();
          } catch {
            this.notify(c.lockFailed);
          }
        }),
      );
    if (isSet) {
      this.row(c.lockRemove).addButton((b) =>
        b.setButtonText(c.lockRemove).setWarning().onClick(async () => {
          if (encryptionConfigured()) return this.notify(SETTINGS_COPY.lock.enc.removeBlocked);
          if (!(await verifyPassphrase(current, lock))) return this.notify(c.lockWrong);
          await this.host.settings().update((x) => void (x.privacy.lock = { ...x.privacy.lock, salt: "", hash: "" }));
          this.notify(c.lockRemoved);
          this.refresh();
        }),
      );
    }
    const minutes = clampAutoLock(lock.autoLockMinutes);
    const choices: Record<string, string> = { "0": c.lockNever };
    for (const m of [1, 5, 10, 15, 30, 60]) choices[String(m)] = fill(c.lockMinutes, { n: m });
    if (!(String(minutes) in choices)) choices[String(minutes)] = fill(c.lockMinutes, { n: minutes });
    this.dropdown(c.lockAuto, c.lockAutoDesc, choices, String(minutes), (x, v) => void (x.privacy.lock.autoLockMinutes = clampAutoLock(Number(v))));
    this.row(c.lockNow).addButton((b) => b.setButtonText(c.lockNow).onClick(() => lockApp()));
  }

  // ───────────────────────────── Lock (own tab) ─────────────────────────────

  private lockTab(s: CortexSettings): void {
    const c = SETTINGS_COPY.lock;
    this.mount.createEl("p", { cls: "cx-note", text: c.hides });
    this.lockSection(s, false);
    this.mount.createEl("p", { cls: "cx-note", text: c.keepsOut });
  }

  // ───────────────────────────── Live capture ─────────────────────────────

  /** Sources as the Live capture tab: the one switch the rail's Live line follows, what is watched, then the source rows. */
  private captureSection(s: CortexSettings): void {
    const c = SETTINGS_COPY.capture;
    const src = s.sources;
    this.toggle(c.live, c.liveDesc, liveCaptureOn(s), (x, v) => applyLiveCapture(x, v), !liveCaptureAvailable(s));
    this.heading(c.watching);
    const watched: string[] = [];
    if (src.vault.enabled) watched.push(c.watchVault);
    if (src.claudeCode.enabled) watched.push(c.watchSessions);
    const folders = src.folders.filter((f) => f.enabled).length;
    if (folders > 0) watched.push(fill(c.watchFolders, { n: folders }));
    if (src.claudeAi.enabled || src.chatgpt.enabled || src.gemini.enabled) watched.push(c.watchFiles);
    if (watched.length === 0) this.mount.createEl("p", { cls: "cx-note", text: c.watchingNone });
    else {
      const ul = this.mount.createEl("ul", { cls: "cx-win-watching" });
      for (const w of watched) ul.createEl("li", { text: w });
    }
    this.sourcesSection(s);
  }

  // ───────────────────────────── Sync (read-only) ─────────────────────────────

  /** What lives where. Cortex has no sync of its own, so this only reports and offers a rebuild and the folders. */
  private syncSection(_s: CortexSettings): void {
    const c = SETTINGS_COPY.sync;
    this.mount.createEl("p", { cls: "cx-note", text: c.note });
    const value = (row: Setting, text: string, tag: string): HTMLElement => {
      const box = row.controlEl.createEl("span", { cls: "cx-win-value" });
      const t = box.createEl("span", { cls: "cx-win-path", text });
      box.createEl("span", { cls: "cx-win-tag", text: tag });
      return t;
    };
    value(this.row(c.device, c.deviceDesc), deviceName(), c.staysHere);
    const vaultRow = this.row(c.vault, c.vaultDesc);
    const vaultPath = value(vaultRow, "…", c.travels);
    this.row(c.record, c.recordDesc).controlEl.createEl("span", { cls: "cx-win-tag", text: c.travels });
    const cacheRow = this.row(c.cache, c.cacheDesc);
    const cachePath = value(cacheRow, "…", c.staysHere);
    const warnVault = this.mount.createEl("p", { cls: "cx-note cx-win-warn is-hidden" });
    const warnCache = this.mount.createEl("p", { cls: "cx-note cx-win-warn is-hidden" });
    void this.services()
      .then((svc) => {
        vaultPath.setText(svc.vaultRoot);
        cachePath.setText(svc.cacheDir);
        vaultRow.addButton((b) => b.setButtonText(c.openFolder).onClick(() => openFolder(svc.vaultRoot)));
        cacheRow.addButton((b) => b.setButtonText(c.openFolder).onClick(() => openFolder(svc.cacheDir)));
        const vaultCloud = cloudFolderOf(svc.vaultRoot);
        const cacheCloud = cloudFolderOf(svc.cacheDir);
        if (cacheCloud) {
          warnCache.setText(fill(c.cloudCache, { service: cacheCloud }));
          warnCache.removeClass("is-hidden");
        } else if (vaultCloud) {
          warnVault.setText(fill(c.cloudVault, { service: vaultCloud }));
          warnVault.removeClass("is-hidden");
        }
      })
      .catch(() => {
        vaultPath.setText("");
        cachePath.setText("");
      });
    this.row(c.rebuild, c.rebuildDesc).addButton((b) =>
      b.setButtonText(c.rebuild).onClick(async () => {
        b.setButtonText(c.rebuilding);
        try {
          await (await this.services()).runner.request({ cmd: "index.build", args: { full: true } });
          this.notify(c.rebuilt);
        } catch {
          this.notify(c.failed);
        } finally {
          b.setButtonText(c.rebuild);
        }
      }),
    );
  }

  // ───────────────────────────── Advanced ─────────────────────────────

  private advanced(s: CortexSettings): void {
    const c = SETTINGS_COPY.advanced;
    const adv = s.advanced;
    this.row(c.cache, c.cacheDesc).addButton((b) =>
      b.setButtonText(c.openFolder).onClick(async () => {
        try {
          openFolder((await this.services()).cacheDir);
        } catch {
          this.notify(c.failed);
        }
      }),
    );
    this.row(c.logs, c.logsDesc).addButton((b) =>
      b.setButtonText(c.openFolder).onClick(async () => {
        try {
          openFolder(`${(await this.services()).vaultRoot}/.vault-meta/cortex`);
        } catch {
          this.notify(c.failed);
        }
      }),
    );
    let nodeButton: { setButtonText(t: string): unknown } | null = null;
    this.row(c.nodePath, c.nodePathDesc)
      .addText((tx) => tx.setValue(adv.nodePath).onChange((v) => this.set((x) => void (x.advanced.nodePath = v.trim()))))
      .addButton((b) => {
        nodeButton = b;
        b.setButtonText(c.test).onClick(async () => {
          nodeButton?.setButtonText(c.testing);
          try {
            const res = await (await this.services()).runner.request({ cmd: "doctor", args: {} });
            this.notify(res.node ? fill(c.nodeFound, { version: res.node }) : c.nodeMissing);
          } catch {
            this.notify(c.nodeMissing);
          } finally {
            nodeButton?.setButtonText(c.test);
          }
        });
      });
    this.row(c.rebuild, c.rebuildDesc).addButton((b) =>
      b.setButtonText(c.rebuild).onClick(async () => {
        b.setButtonText(c.rebuilding);
        try {
          await (await this.services()).runner.request({ cmd: "index.build", args: { full: true } });
          this.notify(c.rebuilt);
        } catch {
          this.notify(c.failed);
        } finally {
          b.setButtonText(c.rebuild);
        }
      }),
    );
    this.row(c.seal, c.sealDesc).addToggle((tg) =>
      tg.setValue(adv.dateSeals.sealLocally).onChange(async (v) => {
        await this.host.settings().update((x) => void (x.advanced.dateSeals.sealLocally = v));
        if (!v) return;
        try {
          await (await this.services()).runner.request({ cmd: "seals.run", args: { force: true } });
        } catch {
          this.notify(c.failed);
        }
        this.refresh();
      }),
    );
    this.renderSeals();
    this.renderStampChecks();
    this.text(c.signAs, c.signAsDesc, adv.dateSeals.signAs, "", (x, v) => void (x.advanced.dateSeals.signAs = v));
    this.slider(c.pointBudget, c.pointBudgetDesc, SETTING_RANGES.pointBudget, 10_000, adv.pointBudget, (x, v) => void (x.advanced.pointBudget = v));
    this.toggle(c.frameRate, undefined, adv.showFrameRate, (x, v) => void (x.advanced.showFrameRate = v));
    this.row(c.diagnostics, c.diagnosticsDesc).addButton((b) =>
      b.setButtonText(c.diagnostics).onClick(async () => {
        try {
          const svc = await this.services();
          const where = await svc.exportDiagnostics();
          if (where) this.notify(fill(c.diagnosticsSaved, { path: where }));
        } catch {
          this.notify(c.failed);
        }
      }),
    );
    this.row(c.resetHints, c.resetHintsDesc).addButton((b) =>
      b.setButtonText(c.resetHints).onClick(async () => {
        try {
          const { resetHints } = await import("../ui/deviceState");
          (await this.services()).device.update(resetHints);
        } catch {
          this.notify(c.failed);
        }
      }),
    );
  }
}
