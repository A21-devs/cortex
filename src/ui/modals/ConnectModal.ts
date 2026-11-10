/**
 * "Connect an agent" (command, header More menu, Guide; P21): the Claude Code sign-in test and setup flow inside
 * a modal, the same check as Settings > Agents > Test. It shows the Claude Code path (empty = look on the PATH),
 * a Test button that asks the runner for a live check (`doctor`), and what to do when it fails. A passing test
 * offers "Turn on agents" once the first-run step has been passed (the consent gate is never skipped from here);
 * a local-engine block in settings (P20) adds "Use a model on this computer". Changes only the two settings it
 * names, and only on the person's click.
 */
import { Modal, Notice, type App } from "obsidian";
import type { CortexServices } from "../../plugin/services";
import type { DoctorResult } from "../../shared/protocol/runner";
import type { CortexSettings } from "../../shared/settings";
import { t } from "../copy";

export type ConnectOutcome = { kind: "ok"; version: string; seconds: string } | { kind: "silent"; version: string } | { kind: "missing" };

/** What a doctor result means for the person (pure). */
export function connectOutcome(res: Pick<DoctorResult, "claude">, seconds: number): ConnectOutcome {
  const v = res.claude.version;
  if (!v) return { kind: "missing" };
  if (res.claude.liveCheck === "failed") return { kind: "silent", version: v };
  return { kind: "ok", version: v, seconds: seconds.toFixed(1) };
}

/** True when settings carry a local-engine block (written by the local engine, P20), so it can be offered. */
export function localEngineOffered(s: Pick<CortexSettings, "agents">): boolean {
  return typeof (s.agents as unknown as { local?: unknown }).local === "object" && (s.agents as unknown as { local?: unknown }).local !== null;
}

export class ConnectModal extends Modal {
  private status!: HTMLElement;
  private actions!: HTMLElement;

  constructor(
    app: App,
    private readonly s: CortexServices,
    private readonly hooks: { openSetup(): void; openAgentSettings(): void },
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("cx-modal", "cx-connect-modal");
    this.titleEl.setText(t("connect.title"));
    this.contentEl.createEl("p", { text: t("connect.intro"), cls: "cx-modal-subtitle" });
    const field = this.contentEl.createEl("label", { cls: "cx-dialog-field" });
    field.createSpan({ text: t("connect.path") });
    const input = field.createEl("input", { attr: { type: "text", placeholder: t("connect.pathPlaceholder") }, cls: "cx-input" }) as HTMLInputElement;
    input.value = this.s.settings.value.agents.claudePath;
    input.addEventListener("change", () => void this.s.settings.update((x) => void (x.agents.claudePath = input.value.trim())));
    this.status = this.contentEl.createDiv({ cls: "cx-connect-status", attr: { role: "status", "aria-live": "polite" } });
    this.actions = this.contentEl.createDiv({ cls: "cx-modal-footer" });
    this.renderActions(null);
  }

  private renderActions(outcome: ConnectOutcome | null): void {
    this.actions.empty();
    const test = this.actions.createEl("button", { text: outcome === null ? t("connect.test") : t("connect.testAgain"), cls: outcome?.kind === "ok" ? "" : "mod-cta" });
    test.addEventListener("click", () => void this.runTest(test));
    if (outcome?.kind === "ok" && !this.s.settings.value.agents.enabled) {
      const on = this.actions.createEl("button", { text: this.s.settings.value.general.firstRunDone ? t("connect.turnOn") : t("connect.finishSetup"), cls: "mod-cta" });
      on.addEventListener("click", () => {
        if (!this.s.settings.value.general.firstRunDone) {
          this.close();
          this.hooks.openSetup();
          return;
        }
        void this.s.settings.update((x) => void (x.agents.enabled = true)).then(() => {
          new Notice(t("connect.turnedOn"));
          this.renderActions(outcome);
        });
      });
    }
    if (localEngineOffered(this.s.settings.value) && this.s.settings.value.agents.engine !== "local") {
      this.actions.createEl("button", { text: t("connect.useLocal") }).addEventListener("click", () => {
        void this.s.settings.update((x) => void (x.agents.engine = "local")).then(() => {
          new Notice(t("connect.localOn"));
          this.renderActions(outcome);
        });
      });
    }
    this.actions.createEl("button", { text: t("connect.settings") }).addEventListener("click", () => {
      this.close();
      this.hooks.openAgentSettings();
    });
  }

  private async runTest(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    this.status.setText(t("connect.testing"));
    let outcome: ConnectOutcome;
    try {
      const started = Date.now();
      const res = await this.s.runner.request({ cmd: "doctor", args: { live: true } });
      outcome = connectOutcome(res, (Date.now() - started) / 1000);
    } catch {
      outcome = { kind: "missing" };
    }
    this.status.empty();
    if (outcome.kind === "ok") this.status.setText(t("connect.ok", { version: outcome.version, s: outcome.seconds }));
    else {
      this.status.createEl("p", { text: outcome.kind === "silent" ? t("connect.silent", { version: outcome.version }) : t("connect.missing") });
      const steps = this.status.createEl("ol");
      for (const step of [t("connect.step1"), t("connect.step2"), t("connect.step3")]) steps.createEl("li", { text: step });
    }
    this.renderActions(outcome);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
