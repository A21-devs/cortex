/**
 * "Export my record": which areas, which period, whether closed areas are included, whether the zip is encrypted with the
 * record's key. Resolves the choice to the caller; nothing is written here. Owner: proof-audit-export.
 */
import { Modal, type App } from "obsidian";
import { SPACES, NO_AREA } from "../../shared/spaces";
import { t } from "../copy";

export interface ExportChoiceDraft {
  areas: string[];
  from?: string;
  to?: string;
  includeClosed: boolean;
  encrypt: boolean;
}

export interface ExportModalProps {
  /** consent.openSpaces: areas, user spaces or folders that are open. */
  openSpaces: readonly string[];
  /** The record's key is held (encryption on and unlocked). */
  canEncrypt: boolean;
  onExport(choice: ExportChoiceDraft): void;
}

const AREAS: readonly { id: string; name: string }[] = [...SPACES.map((s) => ({ id: s.id, name: s.name })), { id: NO_AREA.id, name: NO_AREA.name }];

export class ExportRecordModal extends Modal {
  constructor(
    app: App,
    private readonly props: ExportModalProps,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { props } = this;
    this.modalEl.addClass("cx-modal", "cx-confirm-modal", "cx-export-modal");
    this.titleEl.setText(t("proof.exportTitle"));
    const body = this.contentEl;
    body.createEl("p", { text: t("proof.exportIntro"), cls: "cx-modal-subtitle" });

    const set = new Set(props.openSpaces);
    const fs = body.createEl("fieldset", { cls: "cx-choice-group" });
    fs.createEl("legend", { text: t("proof.exportAreas") });
    const grid = fs.createDiv({ cls: "cx-export-areas" });
    const boxes: { id: string; input: HTMLInputElement }[] = [];
    for (const a of AREAS) {
      const row = grid.createEl("label", { cls: "cx-choice" });
      const input = row.createEl("input", { attr: { type: "checkbox", value: a.id } }) as HTMLInputElement;
      input.checked = true;
      input.setAttr("checked", "true");
      row.createSpan({ text: a.name });
      row.createSpan({ cls: "cx-note", text: set.has(a.id) ? t("proof.exportOpenBadge") : t("proof.exportClosedBadge") });
      boxes.push({ id: a.id, input });
    }

    const dates = body.createDiv({ cls: "cx-dialog-fields" });
    const mk = (label: string): HTMLInputElement => {
      const l = dates.createEl("label", { cls: "cx-dialog-field" });
      l.createSpan({ text: label });
      return l.createEl("input", { attr: { type: "date" }, cls: "cx-input" }) as HTMLInputElement;
    };
    const from = mk(t("proof.exportFrom"));
    const to = mk(t("proof.exportTo"));
    body.createEl("p", { text: t("proof.exportPeriodHint"), cls: "cx-note" });

    const closedRow = body.createEl("label", { cls: "cx-choice" });
    const closed = closedRow.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
    closedRow.createSpan({ text: t("proof.exportClosed") });
    body.createEl("p", { text: t("proof.exportClosedHint"), cls: "cx-note" });
    const noneOpen = body.createEl("p", { text: t("proof.exportNoneOpen"), cls: "cx-note cx-modal-error", attr: { role: "status" } });

    const encRow = body.createEl("label", { cls: "cx-choice" });
    const enc = encRow.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
    encRow.createSpan({ text: t("proof.exportEncrypt") });
    body.createEl("p", { text: props.canEncrypt ? t("proof.exportEncryptHint") : t("proof.exportEncryptOff"), cls: "cx-note" });
    if (!props.canEncrypt) enc.disabled = true;

    const foot = body.createDiv({ cls: "cx-modal-footer" });
    foot.createEl("button", { text: t("dialogs.cancel") }).addEventListener("click", () => this.close());
    const go = foot.createEl("button", { text: t("proof.exportGo"), cls: "mod-cta" });

    const refresh = (): void => {
      const none = !closed.checked && props.openSpaces.length === 0;
      noneOpen.style.display = none ? "" : "none";
      go.disabled = none || boxes.every((b) => !b.input.checked);
    };
    closed.addEventListener("change", refresh);
    closed.addEventListener("click", refresh);
    for (const b of boxes) {
      b.input.addEventListener("change", refresh);
      b.input.addEventListener("click", refresh);
    }
    refresh();

    go.addEventListener("click", () => {
      const picked = boxes.filter((b) => b.input.checked).map((b) => b.id);
      const choice: ExportChoiceDraft = {
        areas: picked.length === boxes.length ? [] : picked,
        ...(from.value ? { from: from.value } : {}),
        ...(to.value ? { to: to.value } : {}),
        includeClosed: closed.checked,
        encrypt: props.canEncrypt && enc.checked,
      };
      this.close();
      props.onExport(choice);
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
