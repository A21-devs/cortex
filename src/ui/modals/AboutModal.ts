/**
 * About Cortex (header More menu and the command "About Cortex"; P21). A small Obsidian Modal: the name, the
 * installed version from the manifest, one line on what Cortex does, and links: the in-app guide, the
 * documentation and the changelog (the repository's readme and releases, when the manifest names a repository),
 * and Check for updates. Opens nothing on its own.
 */
import { Modal, type App } from "obsidian";
import { releasesRepo } from "../../shared/update";
import { t } from "../copy";

export interface AboutInfo {
  version: string;
  description?: string;
  authorUrl?: string;
  id?: string;
}

/** The documentation and changelog addresses (null when no repository is known). */
export function aboutLinks(info: Pick<AboutInfo, "authorUrl" | "id">): { docs: string; changelog: string } | null {
  const repo = releasesRepo(info);
  return repo === null ? null : { docs: `https://github.com/${repo}#readme`, changelog: `https://github.com/${repo}/releases` };
}

export class AboutModal extends Modal {
  constructor(app: App, private readonly info: AboutInfo, private readonly run: (commandId: string) => void) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("cx-modal", "cx-about-modal");
    this.titleEl.setText(t("about.title"));
    this.contentEl.createEl("p", { text: t("about.version", { version: this.info.version }), cls: "cx-modal-subtitle" });
    this.contentEl.createEl("p", { text: t("about.blurb") });
    const links = aboutLinks(this.info);
    const row = this.contentEl.createDiv({ cls: "cx-modal-footer cx-about-links" });
    const action = (label: string, commandId: string): void => {
      row.createEl("button", { text: label }).addEventListener("click", () => {
        this.close();
        this.run(commandId);
      });
    };
    action(t("about.guide"), "open-guide");
    if (links) {
      row.createEl("a", { text: t("about.docs"), href: links.docs, attr: { target: "_blank", rel: "noopener noreferrer" } });
      row.createEl("a", { text: t("about.changelog"), href: links.changelog, attr: { target: "_blank", rel: "noopener noreferrer" } });
    }
    action(t("about.checkUpdates"), "check-updates");
    this.contentEl.createEl("p", { text: t("about.tip"), cls: "cx-modal-note" });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
