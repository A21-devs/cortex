/**
 * The first-run step (CORTEX-UX §5.26; SAFE-11): "Set up your record" (Modal, 720 px), the consent gate. Nothing
 * is imported or sent until Start. Owner: E11 (shell) with E3 (estimate).
 *  - Sources: toggles for This vault's notes, Documents in .raw/ and Claude Code, and a Chat exports row with
 *    Choose…, each with counts from SourcesService.estimate() (a runner dry run that lists files only).
 *  - What happens: Where the text goes · What models read · How long it takes (conversations, notes, tokens and
 *    days at the cap), recomputed from the ticked sources.
 *  - Choice: Import and organise (preselected) · Import only.
 *  - Footer: shield + "Change any of this later in Settings › Privacy and Settings › Agents." Not now · Start.
 * Start records general.firstRunDone, firstRunChoice, agents.enabled and the ticked sources, ticks the checklist's
 * "Add a source", and lets the background tier start (plugin/background.ts). Not now changes nothing. Choose… on
 * the Chat exports row is Start with the current choices, followed by Add sources (an export cannot be read
 * before the gate has been passed).
 */
import { Modal, type App } from "obsidian";
import type { CortexServices } from "../../plugin/services";
import { planCapsOf, type PlanCaps } from "../../shared/planLimits";
import type { EstimateResult } from "../../shared/protocol/runner";
import type { CortexSettings, FirstRunChoice } from "../../shared/settings";
import { t } from "../copy";
import { tickChecklist } from "../deviceState";

/** The three sources the first-run step can switch (chat exports are added later from Add sources). */
export interface FirstRunSources {
  vault: boolean;
  raw: boolean;
  claudeCode: boolean;
}

/** Rough tokens per item: the same figures as importers/registry.ts, which the runner's estimate uses. */
const TOKENS_PER_CONVERSATION = 2500;
const TOKENS_PER_NOTE = 1100;

/** What Start writes (pure, so the gate is testable). `sources` is optional: omitted, the source switches stay as they are. */
export function applyFirstRunChoice(choice: FirstRunChoice, sources?: FirstRunSources, seal?: boolean): (s: CortexSettings) => void {
  return (s) => {
    s.general.firstRunDone = true;
    s.general.firstRunChoice = choice;
    s.agents.enabled = choice === "import-and-organise" || choice === "no-model";
    // No model is a named engine (plain rules, nothing sent); choosing a model instead leaves it.
    if (choice === "no-model") s.agents.engine = "none";
    else if (s.agents.engine === "none") s.agents.engine = "claude-cli";
    if (seal !== undefined) s.advanced.dateSeals.sealLocally = seal;
    if (sources) {
      s.sources.vault.enabled = sources.vault;
      s.sources.raw.enabled = sources.raw;
      s.sources.claudeCode.enabled = sources.claudeCode;
    }
  };
}

/** The "How long it takes" figures for the ticked sources. */
export interface FirstRunFigures {
  conversations: number;
  notes: number;
  tokens: number;
}

/** Counts for the three rows: vault notes outside the hidden reference notes, raw documents, Claude Code sessions. */
export function firstRunCounts(est: EstimateResult): { notes: number; reference: number; raw: number; sessions: number; where: string } {
  const v = est.sources.find((x) => x.source === "obsidian");
  const raw = est.sources.find((x) => x.source === "files" && x.where === undefined);
  const cc = est.sources.find((x) => x.source === "claude-code");
  return {
    notes: v ? v.items - v.reference : 0,
    reference: v ? v.reference : 0,
    raw: raw ? raw.items : 0,
    sessions: cc ? cc.items : 0,
    where: cc?.where ?? "",
  };
}

/** The estimate narrowed to what is ticked: an unticked source takes its conversations/notes (and tokens) back out. */
export function firstRunFigures(est: EstimateResult, ticked: FirstRunSources): FirstRunFigures {
  const c = firstRunCounts(est);
  let conversations = est.conversations;
  let notes = est.notes;
  if (!ticked.claudeCode) conversations = Math.max(0, conversations - c.sessions);
  if (!ticked.vault) notes = Math.max(0, notes - c.notes);
  if (!ticked.raw) notes = Math.max(0, notes - c.raw);
  const tokens = conversations * TOKENS_PER_CONVERSATION + notes * TOKENS_PER_NOTE;
  return { conversations, notes, tokens };
}

/** "5.2 million" above a million, otherwise a grouped integer. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} million`;
  return Math.round(n).toLocaleString("en-US");
}

/** The "How long it takes" sentence: the size of the backlog and the plan caps agents pause at. */
export function longLine(f: FirstRunFigures, caps: PlanCaps): string {
  if (f.tokens === 0) return t("firstRun.longNone");
  return t("firstRun.long", {
    conversations: f.conversations.toLocaleString("en-US"),
    notes: f.notes.toLocaleString("en-US"),
    tokens: formatTokens(f.tokens),
    caps: capsLine(caps),
  });
}

/** "70% of the 5-hour limit and 70% of the weekly limit", or "no plan caps" when both are off. */
export function capsLine(caps: PlanCaps): string {
  const parts: string[] = [];
  if (caps.fiveHour !== null) parts.push(t("firstRun.capFive", { pct: String(caps.fiveHour) }));
  if (caps.weekly !== null) parts.push(t("firstRun.capWeek", { pct: String(caps.weekly) }));
  return parts.length === 0 ? t("firstRun.capNone") : parts.join(t("firstRun.capJoin"));
}

export class FirstRunModal extends Modal {
  private choice: FirstRunChoice = "import-and-organise";
  /** Date-seal new entries (on by default; written to advanced.dateSeals.sealLocally on Start). */
  private seal = true;
  private readonly ticked: FirstRunSources;
  private estimate: EstimateResult | null = null;
  private details!: { vault: HTMLElement; raw: HTMLElement; claudeCode: HTMLElement; long: HTMLElement; read: HTMLElement };

  constructor(app: App, private readonly services: CortexServices) {
    super(app);
    const src = services.settings.value.sources;
    this.ticked = { vault: src.vault.enabled, raw: src.raw.enabled, claudeCode: src.claudeCode.enabled };
  }

  override onOpen(): void {
    this.modalEl.addClass("cx-modal", "cx-first-run-modal");
    this.titleEl.setText(t("firstRun.stepTitle"));
    this.contentEl.createEl("p", { text: t("firstRun.stepSubtitle"), cls: "cx-modal-subtitle" });

    const rows = this.contentEl.createDiv({ cls: "cx-first-run-sources" });
    const vault = this.sourceRow(rows, t("addSources.vault"), "vault");
    const raw = this.sourceRow(rows, t("addSources.raw"), "raw");
    const cc = this.sourceRow(rows, t("addSources.claudeCode"), "claudeCode");
    const ex = rows.createDiv({ cls: "cx-first-run-row" });
    const exText = ex.createDiv({ cls: "cx-first-run-row-text" });
    exText.createDiv({ text: t("firstRun.chatExports"), cls: "cx-first-run-row-name" });
    exText.createDiv({ text: t("firstRun.exportsRow"), cls: "cx-first-run-row-detail" });
    ex.createEl("button", { text: t("addSources.choose"), cls: "cx-first-run-choose" }).addEventListener("click", () => void this.start(true));

    const what = this.contentEl.createDiv({ cls: "cx-first-run-what" });
    this.line(what, t("firstRun.whereTitle"), t("firstRun.where"));
    const read = this.line(what, t("firstRun.readTitle"), t("firstRun.read"));
    const long = this.line(what, t("firstRun.longTitle"), t("firstRun.counting"));
    this.details = { vault: vault.detail, raw: raw.detail, claudeCode: cc.detail, long, read };

    const choices = this.contentEl.createDiv({ cls: "cx-first-run-choices" });
    const options: [FirstRunChoice, string, string][] = [
      ["import-and-organise", t("firstRun.importOrganise"), t("firstRun.importOrganiseDesc")],
      ["no-model", t("firstRun.noModel"), t("firstRun.noModelDesc")],
      ["import-only", t("firstRun.importOnly"), t("firstRun.importOnlyDesc")],
    ];
    for (const [value, name, desc] of options) {
      const label = choices.createEl("label", { cls: "cx-first-run-choice" });
      const radio = label.createEl("input", { type: "radio" } as never) as HTMLInputElement;
      radio.name = "cx-first-run-choice";
      radio.value = value;
      radio.checked = value === this.choice;
      radio.addEventListener("change", () => {
        if (radio.checked) this.choice = value;
        this.setDetails();
      });
      const text = label.createDiv({ cls: "cx-first-run-row-text" });
      text.createDiv({ text: name, cls: "cx-first-run-row-name" });
      text.createDiv({ text: desc, cls: "cx-first-run-row-detail" });
    }

    const sealRow = this.contentEl.createEl("label", { cls: "cx-first-run-choice cx-first-run-seal" });
    const sealBox = sealRow.createEl("input", { type: "checkbox" } as never) as HTMLInputElement;
    sealBox.checked = this.seal;
    sealBox.addEventListener("change", () => {
      this.seal = sealBox.checked;
    });
    const sealText = sealRow.createDiv({ cls: "cx-first-run-row-text" });
    sealText.createDiv({ text: t("firstRun.sealLabel"), cls: "cx-first-run-row-name" });
    sealText.createDiv({ text: t("firstRun.sealDesc"), cls: "cx-first-run-row-detail" });

    const foot = this.contentEl.createDiv({ cls: "cx-modal-footer" });
    foot.createEl("p", { text: t("firstRun.footer") });
    foot.createEl("button", { text: t("firstRun.notNow") }).addEventListener("click", () => this.close());
    foot.createEl("button", { text: t("firstRun.start"), cls: "mod-cta" }).addEventListener("click", () => void this.start(false));

    this.setDetails();
    void this.loadEstimate();
  }

  private sourceRow(parent: HTMLElement, name: string, key: keyof FirstRunSources): { detail: HTMLElement } {
    const row = parent.createDiv({ cls: "cx-first-run-row" });
    const text = row.createDiv({ cls: "cx-first-run-row-text" });
    text.createDiv({ text: name, cls: "cx-first-run-row-name" });
    const detail = text.createDiv({ cls: "cx-first-run-row-detail" });
    const box = row.createEl("input", { type: "checkbox" } as never) as HTMLInputElement;
    box.checked = this.ticked[key];
    box.setAttribute?.("aria-label", name);
    box.addEventListener("change", () => {
      this.ticked[key] = box.checked;
      this.setDetails();
    });
    return { detail };
  }

  private line(parent: HTMLElement, title: string, body: string): HTMLElement {
    const p = parent.createDiv({ cls: "cx-first-run-line" });
    p.createEl("strong", { text: title });
    return p.createDiv({ text: body, cls: "cx-first-run-line-body" });
  }

  private async loadEstimate(): Promise<void> {
    try {
      this.estimate = await this.services.sources.estimate();
    } catch {
      // The estimate needs the runner; the step still works, without counts.
      this.estimate = null;
    }
    this.setDetails();
  }

  /** Rows and the computed card, from the estimate (or "Counting…" when there is none). */
  private setDetails(): void {
    const caps = planCapsOf(this.services.settings.value.agents.planCaps);
    const est = this.estimate;
    // No model: rules read the text on this computer, so nothing is sent and no tokens are spent.
    this.details.read.setText(this.choice === "no-model" ? t("firstRun.readNone") : t("firstRun.read"));
    if (!est) {
      for (const el of [this.details.vault, this.details.raw, this.details.claudeCode, this.details.long]) el.setText(t("firstRun.counting"));
      return;
    }
    const c = firstRunCounts(est);
    this.details.vault.setText(t("firstRun.vaultRow", { n: c.notes.toLocaleString("en-US"), m: c.reference.toLocaleString("en-US") }));
    this.details.raw.setText(t("firstRun.rawRow", { n: c.raw.toLocaleString("en-US") }));
    this.details.claudeCode.setText(t("firstRun.claudeCodeRow", { n: c.sessions.toLocaleString("en-US"), path: c.where }));
    this.details.long.setText(this.choice === "no-model" ? t("firstRun.longRules") : longLine(firstRunFigures(est, this.ticked), caps));
  }

  private async start(thenAddSources: boolean): Promise<void> {
    await this.services.settings.update(applyFirstRunChoice(this.choice, this.ticked, this.seal));
    this.services.device.update((d) => tickChecklist(d, "add-source"));
    this.close();
    if (thenAddSources) {
      const m = await import("./AddSourcesModal");
      new m.AddSourcesModal(this.app, this.services).open();
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
