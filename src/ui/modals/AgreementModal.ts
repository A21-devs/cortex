/**
 * "Show what is sent" (header More menu, Guide page, command; P21). A read-only Modal that repeats the consent and
 * data-flow text of the first-run step and Settings > Privacy: where the text goes, what models read, what is
 * hidden first, and the choice made so far, with a Change link to where that choice is edited (the first-run step
 * before it was made, Settings > Agents after). Changing nothing here; the shown text is the same catalogue
 * strings, so it cannot drift from what the first-run step said.
 */
import { Modal, type App } from "obsidian";
import type { CortexSettings } from "../../shared/settings";
import { t } from "../copy";

export interface AgreementView {
  choiceTitle: string;
  choiceBody: string;
  chosen: boolean;
  hidden: string[];
}

/** What the agreement shows for the current settings (pure). */
export function agreementView(s: Pick<CortexSettings, "general" | "agents" | "privacy">): AgreementView {
  const chosen = s.general.firstRunDone;
  const noModel = s.agents.engine === "none" && chosen && s.agents.enabled;
  const organise = !noModel && (s.general.firstRunChoice === "import-and-organise" || (chosen && s.agents.enabled));
  const hidden: string[] = [];
  if (s.privacy.redact.secrets) hidden.push(t("agreement.secrets"));
  if (s.privacy.redact.emails) hidden.push(t("agreement.emails"));
  if (s.privacy.redact.phones) hidden.push(t("agreement.phones"));
  if (s.privacy.redact.personal) hidden.push(t("agreement.personal"));
  if (s.privacy.redact.custom.length > 0) hidden.push(t("agreement.custom", { n: s.privacy.redact.custom.length }));
  return {
    chosen,
    choiceTitle: !chosen ? t("agreement.notChosen") : noModel ? t("firstRun.noModel") : organise ? t("firstRun.importOrganise") : t("firstRun.importOnly"),
    choiceBody: !chosen ? t("agreement.notChosenBody") : noModel ? t("firstRun.noModelDesc") : organise ? t("firstRun.importOrganiseDesc") : t("firstRun.importOnlyDesc"),
    hidden,
  };
}

export class AgreementModal extends Modal {
  constructor(app: App, private readonly settings: () => CortexSettings, private readonly change: (chosen: boolean) => void) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("cx-modal", "cx-agreement-modal");
    this.titleEl.setText(t("agreement.title"));
    const v = agreementView(this.settings());
    const line = (title: string, body: string): HTMLElement => {
      const p = this.contentEl.createDiv({ cls: "cx-first-run-line" });
      p.createEl("strong", { text: title });
      return p.createDiv({ text: body, cls: "cx-first-run-line-body" });
    };
    line(t("firstRun.whereTitle"), t("firstRun.where"));
    line(t("firstRun.readTitle"), t("firstRun.read"));
    line(t("agreement.hiddenTitle"), v.hidden.length > 0 ? t("agreement.hiddenBody", { list: v.hidden.join(", ") }) : t("agreement.hiddenNone"));
    const choice = line(t("agreement.choiceTitle"), `${v.choiceTitle}. ${v.choiceBody}`);
    choice.createEl("a", { text: t("agreement.change"), href: "#", cls: "cx-agreement-change" }).addEventListener("click", (e) => {
      e.preventDefault();
      this.close();
      this.change(v.chosen);
    });
    this.contentEl.createEl("p", { text: t("firstRun.footer"), cls: "cx-modal-note" });
    const foot = this.contentEl.createDiv({ cls: "cx-modal-footer" });
    foot.createEl("button", { text: t("agreement.close"), cls: "mod-cta" }).addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
