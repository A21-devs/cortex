/**
 * Small confirmation dialogs (CORTEX-UX §5.30.4, §5.24): Remove ‹source›? (Remove / Cancel), Discard this draft?
 * (Discard / Keep writing), and "Open ‹address› in your browser?" for links in inert text (SafeMarkdown).
 * Obsidian Modal, 480 px, focus trapped, Esc cancels. Resolves true only on the confirm button. Owner: E11.
 */
import { Modal, type App } from "obsidian";

export interface ConfirmSpec {
  title: string;
  body?: string;
  confirm: string;
  cancel: string;
  /** Destructive-looking actions use Obsidian's warning style. */
  warning?: boolean;
}

export class ConfirmModal extends Modal {
  private resolved = false;

  constructor(app: App, private readonly spec: ConfirmSpec, private readonly done: (ok: boolean) => void) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("cx-modal", "cx-confirm-modal");
    this.titleEl.setText(this.spec.title);
    if (this.spec.body) this.contentEl.createEl("p", { text: this.spec.body });
    const foot = this.contentEl.createDiv({ cls: "cx-modal-footer" });
    foot.createEl("button", { text: this.spec.cancel }).addEventListener("click", () => this.finish(false));
    foot.createEl("button", { text: this.spec.confirm, cls: this.spec.warning ? "mod-warning" : "mod-cta" }).addEventListener("click", () => this.finish(true));
  }

  private finish(ok: boolean): void {
    this.resolved = true;
    this.done(ok);
    this.close();
  }

  override onClose(): void {
    if (!this.resolved) this.done(false);
    this.contentEl.empty();
  }
}

export function confirm(app: App, spec: ConfirmSpec): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, spec, resolve).open());
}
