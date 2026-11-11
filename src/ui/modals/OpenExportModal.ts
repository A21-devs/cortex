/**
 * "Open an encrypted export": choose a `.cortexenc` file; the bytes are handed to the caller, which opens them with the record's
 * key. The file is read in the page and goes nowhere else. Owner: proof-audit-export (verification pass).
 */
import { Modal, type App } from "obsidian";
import { t } from "../copy";

export interface OpenExportProps {
  onOpen(file: { name: string; bytes: Uint8Array }): void;
}

export class OpenExportModal extends Modal {
  constructor(
    app: App,
    private readonly props: OpenExportProps,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("cx-modal", "cx-confirm-modal", "cx-export-modal");
    this.titleEl.setText(t("proof.openExportTitle"));
    const body = this.contentEl;
    body.createEl("p", { text: t("proof.openExportIntro"), cls: "cx-modal-subtitle" });
    const row = body.createEl("label", { cls: "cx-dialog-field" });
    row.createSpan({ text: t("proof.openExportPick") });
    const input = row.createEl("input", { attr: { type: "file", accept: ".cortexenc" }, cls: "cx-input" }) as HTMLInputElement;
    const foot = body.createDiv({ cls: "cx-modal-footer" });
    foot.createEl("button", { text: t("dialogs.cancel") }).addEventListener("click", () => this.close());
    const go = foot.createEl("button", { text: t("proof.openExportGo"), cls: "mod-cta" });
    go.disabled = true;
    input.addEventListener("change", () => void (go.disabled = !input.files?.[0]));
    go.addEventListener("click", () => {
      const f = input.files?.[0];
      if (!f) return;
      void f.arrayBuffer().then((buf) => {
        this.close();
        this.props.onOpen({ name: f.name, bytes: new Uint8Array(buf) });
      });
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
