/**
 * Correction dialogs (CORTEX-UX §5.30.1; F61, P1), each an Obsidian Modal (480 px, focus trapped, Esc closes)
 * that saves a fix through the caller's handler (CorrectionService) and then posts its change with Undo:
 *  - Correct the date… "What's the right date?": a date field, an optional time, the current evidence (read
 *    only); change "Re-dated to ‹date› · your date overrides the evidence" (action set-date);
 *  - Correct the speaker… "Who wrote this?": You · Assistant · Another person · Tool; Apply to This entry · Every
 *    message from this speaker in this conversation (action set-speaker);
 *  - Leave this out… "Leave this out of Cortex?": scope This entry · This conversation · Everything from ‹source›,
 *    the explanation that nothing is deleted; Leave out / Cancel (action exclude, §5.30.4);
 *  - Pin view… asks for a name (PinnedViewService.save, P2).
 * A dialog stays open with an inline message when saving fails, so nothing is lost. Enter saves, Esc cancels.
 * Owner: E12 (dialogs); the fixes themselves are CorrectionService (E7).
 */
import { Modal, type App } from "obsidian";
import type { Speaker } from "../../shared/types";
import { t } from "../copy";
import { speakerLabel } from "../valueLabels";

export type LeaveOutScope = "entry" | "conversation" | "source";

export type CorrectionDialog =
  | { kind: "date"; target: string; current?: string; evidence?: readonly string[]; onSave(isoDate: string): Promise<void> | void }
  | { kind: "speaker"; target: string; current?: Speaker; inConversation?: boolean; onSave(speaker: Speaker, scope: "entry" | "conversation"): Promise<void> | void }
  | { kind: "leave-out"; target: string; source: string; scopes?: readonly LeaveOutScope[]; onSave(scope: LeaveOutScope): Promise<void> | void }
  | { kind: "pin-view"; current?: string; onSave(name: string): Promise<void> | void };

/** Join a date field and an optional time into an ISO string (local time); null when the date is invalid. */
export function isoFromFields(date: string, time = ""): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!dm) return null;
  const tm = time.trim() === "" ? null : /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (time.trim() !== "" && !tm) return null;
  const y = Number(dm[1]);
  const mo = Number(dm[2]);
  const d = Number(dm[3]);
  const h = tm ? Number(tm[1]) : 12;
  const mi = tm ? Number(tm[2]) : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  // Reject roll-overs such as 2026-02-31 → 3 March.
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt.toISOString();
}

/** The date and time fields for an ISO date (local time), for prefilling the dialog. */
export function fieldsFromIso(iso: string | undefined): { date: string; time: string } {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return { date: "", time: "" };
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, time: `${p2(d.getHours())}:${p2(d.getMinutes())}` };
}

/** A pinned view's name: trimmed, 1–80 characters; null when empty. */
export function cleanViewName(name: string): string | null {
  const n = name.replace(/\s+/g, " ").trim().slice(0, 80);
  return n.length > 0 ? n : null;
}

const TITLES = { date: "dialogs.dateTitle", speaker: "dialogs.speakerTitle", "leave-out": "dialogs.leaveOutTitle", "pin-view": "dialogs.pinTitle" } as const;
const SPEAKER_CHOICES: readonly Speaker[] = ["you", "assistant", "other", "tool"];

type El = HTMLElement;

function valueOf(el: El | null): string {
  const v = (el as unknown as { value?: unknown } | null)?.value;
  return typeof v === "string" ? v : "";
}

export class CorrectionModal extends Modal {
  private busy = false;
  private errorEl: El | null = null;
  private saveEl: El | null = null;
  private submitFn: (() => Promise<void> | null) | null = null;

  constructor(app: App, private readonly dialog: CorrectionDialog) {
    super(app);
  }

  override onOpen(): void {
    const d = this.dialog;
    this.modalEl.addClass("cx-modal", "cx-correction-modal");
    this.titleEl.setText(t(TITLES[d.kind]));
    const body = this.contentEl.createDiv({ cls: "cx-dialog-body" });
    switch (d.kind) {
      case "date":
        this.buildDate(body, d);
        break;
      case "speaker":
        this.buildSpeaker(body, d);
        break;
      case "leave-out":
        this.buildLeaveOut(body, d);
        break;
      case "pin-view":
        this.buildPin(body, d);
        break;
    }
    this.errorEl = this.contentEl.createEl("p", { cls: "cx-modal-error", attr: { role: "alert" } });
    const foot = this.contentEl.createDiv({ cls: "cx-modal-footer" });
    foot.createEl("button", { text: t("dialogs.cancel") }).addEventListener("click", () => this.close());
    const label = d.kind === "leave-out" ? t("dialogs.leaveOutButton") : t("dialogs.save");
    this.saveEl = foot.createEl("button", { text: label, cls: d.kind === "leave-out" ? "mod-warning" : "mod-cta" });
    this.saveEl.addEventListener("click", () => void this.submit());
    this.contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
      const tag = ((e.target as El | null)?.tagName ?? "").toLowerCase();
      if (e.key === "Enter" && !e.isComposing && tag === "input") {
        e.preventDefault();
        void this.submit();
      }
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.submitFn = null;
  }

  /** Validate and save; stays open with a message when validation or saving fails. */
  async submit(): Promise<boolean> {
    if (this.busy || !this.submitFn) return false;
    let pending: Promise<void> | null;
    try {
      pending = this.submitFn();
    } catch {
      this.showError(t("dialogs.failed"));
      return false;
    }
    if (pending === null) return false;
    this.busy = true;
    const label = this.saveEl ? (this.saveEl.textContent ?? "") : "";
    this.saveEl?.setText(t("dialogs.saving"));
    this.saveEl?.setAttr("disabled", "true");
    try {
      await pending;
      this.close();
      return true;
    } catch {
      this.showError(t("dialogs.failed"));
      return false;
    } finally {
      this.busy = false;
      if (label) this.saveEl?.setText(label);
      this.saveEl?.removeAttribute?.("disabled");
    }
  }

  private showError(msg: string): void {
    this.errorEl?.setText(msg);
  }

  private radioGroup<V extends string>(parent: El, name: string, legend: string, options: readonly { value: V; label: string }[], initial: V, onPick: (v: V) => void): void {
    const fs = parent.createEl("fieldset", { cls: "cx-choice-group" });
    fs.createEl("legend", { text: legend });
    for (const o of options) {
      const row = fs.createEl("label", { cls: "cx-choice" });
      const input = row.createEl("input", { attr: { type: "radio", name, value: o.value } }) as HTMLInputElement;
      if (o.value === initial) {
        input.checked = true;
        input.setAttr("checked", "true");
      }
      const pick = () => onPick(o.value);
      input.addEventListener("change", pick);
      input.addEventListener("click", pick);
      row.createSpan({ text: o.label });
    }
  }

  private buildDate(body: El, d: Extract<CorrectionDialog, { kind: "date" }>): void {
    const initial = fieldsFromIso(d.current);
    const row = body.createDiv({ cls: "cx-dialog-fields" });
    const dateLabel = row.createEl("label", { cls: "cx-dialog-field" });
    dateLabel.createSpan({ text: t("dialogs.date") });
    const date = dateLabel.createEl("input", { attr: { type: "date", required: "true" }, cls: "cx-input" }) as HTMLInputElement;
    date.value = initial.date;
    const timeLabel = row.createEl("label", { cls: "cx-dialog-field" });
    timeLabel.createSpan({ text: t("dialogs.time") });
    const time = timeLabel.createEl("input", { attr: { type: "time" }, cls: "cx-input" }) as HTMLInputElement;
    time.value = initial.time;
    const ev = body.createDiv({ cls: "cx-dialog-evidence" });
    ev.createEl("p", { cls: "cx-section-label", text: t("dialogs.evidence") });
    const list = ev.createEl("ul");
    if (!d.evidence || d.evidence.length === 0) list.createEl("li", { text: t("dialogs.noEvidence") });
    else for (const line of d.evidence) list.createEl("li", { text: line });
    this.submitFn = () => {
      const iso = isoFromFields(valueOf(date), valueOf(time));
      if (!iso) {
        this.showError(t("dialogs.dateInvalid"));
        return null;
      }
      return Promise.resolve(d.onSave(iso));
    };
    date.focus?.();
  }

  private buildSpeaker(body: El, d: Extract<CorrectionDialog, { kind: "speaker" }>): void {
    let speaker: Speaker = d.current ?? "you";
    let scope: "entry" | "conversation" = "entry";
    this.radioGroup(
      body,
      "cx-speaker",
      t("dialogs.speakerTitle"),
      SPEAKER_CHOICES.map((s) => ({ value: s, label: speakerLabel(s) })),
      speaker,
      (v) => (speaker = v),
    );
    if (d.inConversation) {
      this.radioGroup(
        body,
        "cx-speaker-scope",
        t("dialogs.applyTo"),
        [
          { value: "entry" as const, label: t("dialogs.thisEntry") },
          { value: "conversation" as const, label: t("dialogs.everyMessage") },
        ],
        scope,
        (v) => (scope = v),
      );
    }
    this.submitFn = () => Promise.resolve(d.onSave(speaker, scope));
  }

  private buildLeaveOut(body: El, d: Extract<CorrectionDialog, { kind: "leave-out" }>): void {
    const scopes = d.scopes && d.scopes.length > 0 ? d.scopes : (["entry"] as const);
    let scope: LeaveOutScope = scopes[0] ?? "entry";
    const label = (s: LeaveOutScope) => (s === "entry" ? t("dialogs.thisEntry") : s === "conversation" ? t("dialogs.thisConversation") : t("dialogs.everythingFrom", { source: d.source }));
    this.radioGroup(
      body,
      "cx-leave-scope",
      t("dialogs.scope"),
      scopes.map((s) => ({ value: s, label: label(s) })),
      scope,
      (v) => (scope = v),
    );
    body.createEl("p", { cls: "cx-dialog-explain", text: t("dialogs.leaveOutBody") });
    this.submitFn = () => Promise.resolve(d.onSave(scope));
  }

  private buildPin(body: El, d: Extract<CorrectionDialog, { kind: "pin-view" }>): void {
    const field = body.createEl("label", { cls: "cx-dialog-field" });
    field.createSpan({ text: t("dialogs.pinName") });
    const input = field.createEl("input", { attr: { type: "text", maxlength: "80", placeholder: t("dialogs.pinPlaceholder") }, cls: "cx-input" }) as HTMLInputElement;
    input.value = d.current ?? "";
    this.submitFn = () => {
      const name = cleanViewName(valueOf(input));
      if (!name) {
        this.showError(t("dialogs.pinEmpty"));
        return null;
      }
      return Promise.resolve(d.onSave(name));
    };
    input.focus?.();
  }
}

/** Open a correction dialog; the caller's onSave runs when the user saves (the dialog closes on success). */
export function openCorrection(app: App, dialog: CorrectionDialog): CorrectionModal {
  const m = new CorrectionModal(app, dialog);
  m.open();
  return m;
}
